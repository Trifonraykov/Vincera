import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { InboxList } from "@/components/messages/inbox-list"
import { MessageComposer } from "@/components/messages/message-composer"
import { NotificationList } from "@/components/notifications/notification-list"
import { ProposalActions } from "@/components/proposals/proposal-actions"
import { ProposalForm } from "@/components/proposals/proposal-form"
import { ProposalList } from "@/components/proposals/proposal-list"
import { RevisionHistory, TermsList } from "@/components/proposals/terms"
import { NotificationPrefsForm } from "@/components/settings/notification-prefs-form"
import { NOTIFICATION_TYPES, REQUIRED_EMAIL_TYPES } from "@/lib/notifications/types"

/**
 * Server-rendered proposal, inbox and notification UI (CLAUDE.md §19.26): the markup a phone gets
 * before hydration. Labels, the linked split fields, the answer buttons, highlighted changes, the
 * 44 px rows and the composer.
 */

const NOW = new Date("2026-10-05T12:00:00Z")
const ID = "0190a000-0000-7000-8000-000000000001"
const ID2 = "0190a000-0000-7000-8000-000000000002"
const terms = { creatorSplitPct: 60, builderSplitPct: 40, timelineWeeks: 6, scope: "A web app" }

describe("ProposalForm", () => {
  const html = renderToStaticMarkup(
    createElement(ProposalForm, {
      mode: "send",
      hidden: { to: ID, targetKind: "idea", targetId: ID2 },
      defaults: { scope: "", message: "", creatorSplitPct: 55, timelineWeeks: 4 },
    }),
  )

  it("submits the target, the linked split and the terms, with labels and hints", () => {
    expect(html).toContain(`type="hidden" name="to" value="${ID}"`)
    expect(html).toContain('name="targetKind" value="idea"')
    expect(html).toMatch(/<input[^>]*name="creatorSplitPct"[^>]*value="55"/)
    expect(html).toMatch(/<input[^>]*name="builderSplitPct"[^>]*value="45"/)
    expect(html).toMatch(/type="range"[^>]*aria-label="Creator&#x27;s share"/)
    expect(html).toContain("Revenue split</legend>")
    expect(html).toContain("What you&#x27;ll build together")
    expect(html).toMatch(/name="timelineWeeks"[^>]*value="4"/)
    expect(html).toContain("data-form-actions")
    expect(html).toContain("Send proposal")
  })
})

describe("ProposalActions", () => {
  it("offers accept, counter and decline to the party who answers", () => {
    const html = renderToStaticMarkup(
      createElement(ProposalActions, {
        layout: "sticky",
        proposalId: ID,
        revisionId: ID2,
        actions: ["accept", "counter", "decline"],
        terms,
        counterpartName: "Ada",
      }),
    )
    expect(html).toContain("data-form-actions")
    for (const label of ["Accept", "Counter", "Decline"]) expect(html).toContain(label)
    expect(html).not.toContain("Withdraw")
  })

  it("offers withdraw to the author and nothing on closed proposals", () => {
    const withdraw = renderToStaticMarkup(
      createElement(ProposalActions, {
        layout: "inline",
        proposalId: ID,
        revisionId: ID2,
        actions: ["withdraw"],
        terms,
        counterpartName: "Ada",
      }),
    )
    expect(withdraw).toContain("Withdraw proposal")
    expect(withdraw).not.toContain(">Accept<")
    const none = renderToStaticMarkup(
      createElement(ProposalActions, {
        layout: "inline",
        proposalId: ID,
        revisionId: ID2,
        actions: [],
        terms,
        counterpartName: "Ada",
      }),
    )
    expect(none).toBe("")
  })
})

describe("terms and history", () => {
  const first = {
    id: ID,
    revisionNumber: 1,
    authorUserId: ID,
    message: "Hello",
    scope: "A web app",
    creatorSplitPct: 55,
    builderSplitPct: 45,
    timelineWeeks: 6,
    createdAt: new Date("2026-10-04T12:00:00Z"),
  }
  const second = {
    ...first,
    id: ID2,
    revisionNumber: 2,
    authorUserId: ID2,
    message: null,
    creatorSplitPct: 65,
    builderSplitPct: 35,
    createdAt: new Date("2026-10-05T11:00:00Z"),
  }
  const parties = new Map([
    [ID, { userId: ID, role: "builder" as const, name: "Bo", handle: "bo" }],
    [ID2, { userId: ID2, role: "creator" as const, name: "Ada", handle: "ada" }],
  ])

  it("marks what a counter-offer changed, in words too", () => {
    const html = renderToStaticMarkup(createElement(TermsList, { terms: second, previous: first }))
    expect(html).toContain("Creator 65% · Builder 35%")
    expect(html).toContain('<span class="sr-only">changed, </span>was 55% / 45%')
    expect(html).not.toContain("was 6 weeks")
  })

  it("lists offers newest first with who made them", () => {
    const html = renderToStaticMarkup(
      createElement(RevisionHistory, {
        revisions: [first, second],
        parties,
        viewerId: ID,
        now: NOW,
      }),
    )
    expect(html.indexOf("Counter-offer")).toBeLessThan(html.indexOf("First offer"))
    expect(html).toContain("by Ada (creator)")
    expect(html).toContain("by you (builder)")
    expect(html).toContain("On the table")
  })
})

describe("lists", () => {
  it("renders proposals as 44 px links with whose turn it is", () => {
    const html = renderToStaticMarkup(
      createElement(ProposalList, {
        now: NOW,
        items: [
          {
            id: ID,
            status: "countered",
            target: { kind: "idea", id: ID2, title: "Recipe planner" },
            counterpart: { userId: ID2, role: "creator", name: "Ada", handle: "ada" },
            sentByUser: true,
            yourTurn: true,
            revisionNumber: 2,
            creatorSplitPct: 65,
            builderSplitPct: 35,
            timelineWeeks: 8,
            expiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
            updatedAt: NOW,
            closedAt: null,
          },
        ],
      }),
    )
    expect(html).toContain(`href="/app/proposals/${ID}"`)
    expect(html).toContain("min-h-11")
    expect(html).toContain("Your turn")
    expect(html).toContain("To Ada")
    expect(html).toContain("Answer in 3 days")
  })

  it("renders the inbox with unread counts and previews", () => {
    const html = renderToStaticMarkup(
      createElement(InboxList, {
        now: NOW,
        threads: [
          {
            id: ID,
            kind: "proposal",
            href: `/app/proposals/${ID2}#messages`,
            title: "Recipe planner",
            with: ["Ada"],
            parentStatus: "pending",
            lastMessageAt: new Date(NOW.getTime() - 5 * 60_000),
            preview: "Hello there",
            previewByUser: false,
            unread: 2,
          },
        ],
      }),
    )
    expect(html).toContain(`href="/app/proposals/${ID2}#messages"`)
    expect(html).toContain('aria-label="2 unread"')
    expect(html).toContain("5 min ago")
    expect(html).toContain("Recipe planner · Proposal · Waiting for an answer")
  })

  it("renders notifications as buttons that open them, unread ones announced", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationList, {
        now: NOW,
        items: [
          {
            id: ID,
            type: "proposal.received",
            payload: {
              proposal_id: ID2,
              counterpart_name: "Bo",
              target_kind: "idea",
              target_title: "Recipe planner",
            },
            href: `/app/proposals/${ID2}`,
            readAt: null,
            createdAt: NOW,
          },
        ],
      }),
    )
    expect(html).toContain(`name="id" value="${ID}"`)
    expect(html).toContain('<span class="sr-only">Unread: </span>Bo sent you a proposal')
    expect(html).toContain("About “Recipe planner”")
  })
})

describe("composer and settings", () => {
  it("has a labelled message box, an attach button and a send button", () => {
    const html = renderToStaticMarkup(createElement(MessageComposer, { threadId: ID }))
    expect(html).toContain(`name="threadId" value="${ID}"`)
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>Message<\/label>/)
    expect(html).toContain('aria-label="Attach files"')
    expect(html).toMatch(/type="file"[^>]*multiple/)
    expect(html).toContain('name="attachments" value="[]"')
  })

  it("groups the notification switches like the catalog", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPrefsForm, {
        prefs: NOTIFICATION_TYPES.map((type) => ({
          type,
          email: true,
          inApp: type !== "task.assigned",
        })),
      }),
    )
    for (const group of ["Account", "Proposals", "Collabs"])
      expect(html).toContain(`>${group}</h2>`)
    // A required email (the signed agreement, CLAUDE.md §19.30) has no switch to turn off.
    expect(html.match(/name="email"/g)).toHaveLength(
      NOTIFICATION_TYPES.length - REQUIRED_EMAIL_TYPES.length,
    )
    expect(html).toContain("Always emailed: it carries your signed agreement.")
    expect(html).toMatch(/name="inApp" value="task.assigned"(?![^>]*checked)/)
  })
})
