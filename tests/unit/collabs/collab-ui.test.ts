import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AgreementDocument } from "@/components/collabs/agreement-document"
import { CollabList } from "@/components/collabs/collab-list"
import { CollabNav } from "@/components/collabs/collab-nav"
import { MemberList } from "@/components/collabs/member-list"
import { SignAgreementForm } from "@/components/collabs/sign-agreement-form"
import { CollabStageFilter } from "@/components/collabs/stage-filter"
import { TaskBoard } from "@/components/collabs/task-board"
import { TaskForm } from "@/components/collabs/task-form"
import {
  PLACEHOLDER_CONTEXT_V1,
  PLACEHOLDER_TERMS_V1,
  renderAgreementV1,
} from "@/lib/agreements/template-v1"

/**
 * Server-rendered collab UI (CLAUDE.md §19.28): the markup a phone gets before hydration. The
 * agreement text's structure, the signing form (labels, the hidden fingerprint, the sticky bar),
 * the section links, 44 px targets, the task board and form, and the list rows.
 */

const NOW = new Date("2026-10-05T12:00:00Z")
const ID = "0190a000-0000-7000-8000-000000000001"
const ADA = "0190a000-0000-7000-8000-00000000000a"
const BO = "0190a000-0000-7000-8000-00000000000b"
const members = [
  { userId: ADA, role: "creator" as const, name: "Ada Codes", splitPct: 60, handle: "ada" },
  { userId: BO, role: "builder" as const, name: "Bo Builder", splitPct: 40, handle: null },
]

describe("AgreementDocument", () => {
  const body = renderAgreementV1(PLACEHOLDER_TERMS_V1, PLACEHOLDER_CONTEXT_V1)

  it("renders the stored text as headings, lists and the quoted scope", () => {
    const html = renderToStaticMarkup(createElement(AgreementDocument, { body }))
    expect(html).toContain(
      '<h2 class="text-xl font-semibold tracking-tight">Collaboration agreement</h2>',
    )
    expect(html).toContain(">1. Parties</h3>")
    expect(html).toContain("<blockquote")
    expect(html).toContain(
      '<li class="break-words">the Creator ([Creator&#x27;s name]) receives 60%;</li>',
    )
    expect(html).toContain("Draft — pending legal review.")
  })

  it("can leave the title to the page", () => {
    const html = renderToStaticMarkup(createElement(AgreementDocument, { body, showTitle: false }))
    expect(html).not.toContain("<h2")
  })
})

describe("SignAgreementForm", () => {
  it("sends the fingerprint with the typed name, from a sticky bar", () => {
    const html = renderToStaticMarkup(
      createElement(
        SignAgreementForm,
        { agreementId: ID, bodyHash: "a".repeat(64), signingAs: "the Creator", blocked: null },
        createElement("p", null, "THE TEXT"),
      ),
    )
    expect(html).toContain(`name="agreementId" value="${ID}"`)
    expect(html).toContain(`name="bodyHash" value="${"a".repeat(64)}"`)
    expect(html).toContain("THE TEXT")
    expect(html).toContain("Type your full name to sign")
    const input = /<input[^>]*name="typedName"[^>]*>/.exec(html)?.[0] ?? ""
    expect(input).toContain('autoComplete="name"')
    expect(input).toContain("text-base")
    expect(input).not.toContain('disabled=""')
    expect(html).toContain("data-form-actions")
    expect(html).toContain("Sign the agreement")
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/)
  })

  it("is disabled with the reason when payouts are missing", () => {
    const html = renderToStaticMarkup(
      createElement(
        SignAgreementForm,
        {
          agreementId: ID,
          bodyHash: "a".repeat(64),
          signingAs: "the Builder",
          blocked: createElement("p", null, "Set up payouts before you sign"),
        },
        null,
      ),
    )
    expect(html).toContain("Set up payouts before you sign")
    expect(/<input[^>]*name="typedName"[^>]*>/.exec(html)?.[0]).toContain('disabled=""')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
  })
})

describe("CollabNav", () => {
  it("links the sections with 44 px targets and marks the current one", () => {
    const html = renderToStaticMarkup(
      createElement(CollabNav, {
        collabId: ID,
        current: "tasks",
        badges: { tasks: { count: 2, label: "2 open tasks" } },
      }),
    )
    for (const path of ["", "/agreement", "/tasks", "/messages"]) {
      expect(html).toContain(`href="/app/collabs/${ID}${path}"`)
    }
    expect(html).toMatch(/aria-current="page"[^>]*>.*Tasks/)
    expect(html).toContain('aria-label="2 open tasks"')
    expect(html).toContain("h-11")
  })
})

describe("MemberList", () => {
  it("shows splits, signatures and payouts readiness", () => {
    const html = renderToStaticMarkup(
      createElement(MemberList, {
        members,
        viewerId: ADA,
        signatures: new Map([[ADA, { typedName: "Ada Lovelace", signedAt: NOW }]]),
        payoutsReady: new Map([
          [ADA, true],
          [BO, false],
        ]),
      }),
    )
    expect(html).toContain('href="/c/ada"')
    expect(html).toContain("(you)")
    expect(html).toContain("Signed as “Ada Lovelace”")
    expect(html).toContain("Not signed yet")
    expect(html).toContain("Payouts not set up yet")
    expect(html).toContain(">60%<")
  })
})

describe("TaskBoard", () => {
  const props = {
    collabId: ID,
    members: members.map(({ userId, name, role }) => ({ userId, name, role })),
    viewerId: ADA,
    now: NOW.toISOString(),
  }

  it("lists open tasks with labelled checkboxes, due days and a menu per task", () => {
    const html = renderToStaticMarkup(
      createElement(TaskBoard, {
        ...props,
        canWork: true,
        open: [
          {
            id: "t1",
            title: "Sketch screens",
            description: null,
            assigneeUserId: BO,
            dueDate: "2026-10-01",
            doneAt: null,
            completedByUserId: null,
          },
        ],
        done: [
          {
            id: "t2",
            title: "Pick a name",
            description: null,
            assigneeUserId: null,
            dueDate: null,
            doneAt: "2026-10-04T10:00:00.000Z",
            completedByUserId: ADA,
          },
        ],
      }),
    )
    expect(html).toContain("Mark “Sketch screens” as done")
    expect(html).toContain("Reopen “Pick a name”")
    expect(html).toContain("Overdue · ")
    expect(html).toContain("Bo Builder")
    expect(html).toContain("Done by You on 4 Oct")
    expect(html).toContain("Options for “Sketch screens”")
    expect(html).toContain("size-11")
  })

  it("is read-only for people who cannot work in the collab", () => {
    const html = renderToStaticMarkup(
      createElement(TaskBoard, { ...props, canWork: false, open: [], done: [] }),
    )
    expect(html).toContain("No tasks yet")
    expect(html).not.toContain("New task")
  })
})

describe("TaskForm", () => {
  it("has labelled fields with 16 px inputs and members to pick", () => {
    const html = renderToStaticMarkup(
      createElement(TaskForm, {
        mode: "create",
        collabId: ID,
        defaults: { title: "", description: "", assigneeUserId: "", dueDate: "" },
        members: members.map(({ userId, name, role }) => ({ userId, name, role })),
        viewerId: ADA,
        onDone: () => undefined,
        onCancel: () => undefined,
      }),
    )
    expect(html).toContain(`name="collabId" value="${ID}"`)
    expect(html).toContain(">Nobody yet</option>")
    expect(html).toContain(">You (Ada Codes)</option>")
    expect(html).toContain('type="date"')
    expect(html).toContain("text-base")
    expect(html).toContain("Add task")
  })
})

describe("collab lists", () => {
  it("rows link to the agreement when it waits for the viewer", () => {
    const html = renderToStaticMarkup(
      createElement(CollabList, {
        now: NOW,
        items: [
          {
            id: ID,
            stage: "agreement",
            title: "Budget tracker",
            targetKind: "idea",
            role: "creator",
            splitPct: 60,
            partners: [{ name: "Bo Builder", role: "builder" }],
            agreementStatus: "awaiting_signatures",
            signedByViewer: false,
            signatureCount: 0,
            openTasks: 0,
            lastActivityAt: NOW,
            stageChangedAt: NOW,
          },
        ],
      }),
    )
    expect(html).toContain(`href="/app/collabs/${ID}/agreement"`)
    expect(html).toContain("Your turn")
    expect(html).toContain("Sign the agreement")
    expect(html).toContain("With Bo Builder")
  })

  it("filters by stage with 44 px chips, hiding empty stages", () => {
    const html = renderToStaticMarkup(
      createElement(CollabStageFilter, {
        current: "active",
        counts: {
          active: 2,
          agreement: 1,
          building: 1,
          launch_review: 0,
          live: 0,
          ended: 0,
          all: 2,
        },
      }),
    )
    expect(html).toContain('href="/app/collabs?stage=building"')
    expect(html).not.toContain("stage=live")
    expect(html).toContain("min-h-11")
  })
})
