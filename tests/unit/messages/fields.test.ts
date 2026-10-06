import { describe, expect, it } from "vitest"

import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_POLICY,
  attachmentRefsSchema,
  attachmentTypeOf,
  checkAttachment,
  displayFilename,
  isOwnMessageUploadKey,
  MESSAGE_BODY_MAX,
  messageBodySchema,
} from "@/lib/messages/fields"
import { describeNotification } from "@/lib/notifications/describe"
import { NOTIFICATION_TYPES, type ParsedNotification } from "@/lib/notifications/types"

/** Message bodies and attachments (§14: 25 MB, MIME allow-list), and notification wording. */

const USER = "0190a000-0000-7000-8000-000000000001"
const MB = 1024 * 1024

describe("attachment policy", () => {
  it("allows the attachment purpose's types up to 25 MB, each with one extension", () => {
    expect(ATTACHMENT_POLICY.maxBytes).toBe(25 * MB)
    expect(Object.keys(ATTACHMENT_EXTENSIONS).sort()).toEqual(
      [...ATTACHMENT_POLICY.mimeTypes].sort(),
    )
    expect(new Set(Object.values(ATTACHMENT_EXTENSIONS)).size).toBe(
      Object.values(ATTACHMENT_EXTENSIONS).length,
    )
    expect(ATTACHMENT_ACCEPT).toContain("application/pdf")
    expect(ATTACHMENT_ACCEPT).toContain(".md")
  })

  it("checks type, size and emptiness in plain language", () => {
    expect(checkAttachment({ contentType: "application/pdf", sizeBytes: MB })).toEqual({
      ok: true,
      contentType: "application/pdf",
    })
    expect(checkAttachment({ contentType: "Image/PNG; charset=binary", sizeBytes: 10 })).toEqual({
      ok: true,
      contentType: "image/png",
    })
    for (const type of ["text/html", "image/svg+xml", "application/x-msdownload", ""]) {
      expect(checkAttachment({ contentType: type, sizeBytes: 10 })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/You can attach images, PDFs/),
      })
    }
    expect(checkAttachment({ contentType: "application/pdf", sizeBytes: 25 * MB + 1 })).toEqual({
      ok: false,
      message: "This file is too large. The limit is 25 MB.",
    })
    expect(checkAttachment({ contentType: "application/pdf", sizeBytes: 0 })).toEqual({
      ok: false,
      message: "This file is empty.",
    })
  })

  it("falls back to the extension when the browser gives no type", () => {
    expect(attachmentTypeOf({ name: "notes.md", type: "" })).toBe("text/markdown")
    expect(attachmentTypeOf({ name: "Deck.PPTX", type: "" })).toContain("presentationml")
    expect(attachmentTypeOf({ name: "photo.jpg", type: "image/jpeg" })).toBe("image/jpeg")
    expect(attachmentTypeOf({ name: "virus.exe", type: "" })).toBe("")
  })

  it("accepts only the user's own upload keys with an allowed extension", () => {
    expect(isOwnMessageUploadKey(USER, `message-uploads/${USER}/0190abcd-1234.pdf`)).toBe(true)
    expect(isOwnMessageUploadKey(USER, `message-uploads/someone-else/0190abcd.pdf`)).toBe(false)
    expect(isOwnMessageUploadKey(USER, `message-attachments/${USER}/0190abcd.pdf`)).toBe(false)
    expect(isOwnMessageUploadKey(USER, `message-uploads/${USER}/0190abcd.html`)).toBe(false)
    expect(isOwnMessageUploadKey(USER, `message-uploads/${USER}/../x/0190abcd.pdf`)).toBe(false)
    expect(isOwnMessageUploadKey(USER, `message-uploads/${USER}/a/b.pdf`)).toBe(false)
  })

  it("shows file names without paths or control characters, at most 120 characters", () => {
    expect(displayFilename("C:\\Users\\ada\\Brief.pdf")).toBe("Brief.pdf")
    expect(displayFilename("../../etc/passwd")).toBe("passwd")
    expect(displayFilename("bad\u0000name\u0007.txt")).toBe("badname.txt")
    expect(displayFilename("   ")).toBe("file")
    const long = displayFilename(`${"x".repeat(200)}.pdf`)
    expect(long).toHaveLength(120)
    expect(long.endsWith("….pdf")).toBe(true)
  })
})

describe("message input", () => {
  it("requires a body, trims it and counts CRLF as one character", () => {
    expect(messageBodySchema.parse("  hi there \r\n")).toBe("hi there")
    expect(messageBodySchema.safeParse("   ").success).toBe(false)
    expect(messageBodySchema.safeParse("a".repeat(MESSAGE_BODY_MAX + 1)).success).toBe(false)
    expect(messageBodySchema.parse("a\r\n".repeat(MESSAGE_BODY_MAX / 2))).not.toContain("\r")
  })

  it("parses the composer's attachment list (JSON from a hidden field), at most five", () => {
    expect(attachmentRefsSchema.parse(undefined)).toEqual([])
    expect(attachmentRefsSchema.parse("")).toEqual([])
    expect(attachmentRefsSchema.parse('[{"key":"k","filename":"a.pdf"}]')).toEqual([
      { key: "k", filename: "a.pdf" },
    ])
    expect(attachmentRefsSchema.safeParse("not json").success).toBe(false)
    const six = JSON.stringify(Array.from({ length: 6 }, () => ({ key: "k", filename: "f" })))
    expect(attachmentRefsSchema.safeParse(six).error?.issues[0]?.message).toMatch(/up to 5 files/)
  })
})

describe("notification wording", () => {
  const ID = "0190a000-0000-7000-8000-000000000002"
  const proposal = {
    proposal_id: ID,
    counterpart_name: "Ada",
    target_kind: "idea" as const,
    target_title: "Budget app",
  }
  const agreement = { collab_id: ID, agreement_id: ID, collab_title: "Budget app" }
  const samples: ParsedNotification[] = [
    { type: "social.expired", payload: { connection_id: ID, provider: "youtube" } },
    { type: "payouts.ready", payload: { stripe_account_id: "acct_1" } },
    { type: "proposal.received", payload: proposal },
    { type: "proposal.countered", payload: { ...proposal, revision_number: 2 } },
    { type: "proposal.accepted", payload: { ...proposal, collab_id: ID } },
    { type: "proposal.declined", payload: proposal },
    { type: "proposal.withdrawn", payload: proposal },
    { type: "proposal.expired", payload: proposal },
    { type: "agreement.ready", payload: agreement },
    { type: "agreement.signed", payload: { ...agreement, signer_name: "Bo" } },
    { type: "agreement.completed", payload: agreement },
    { type: "agreement.reminder", payload: { ...agreement, days_waiting: 3 } },
    {
      type: "collab.stalled",
      payload: { collab_id: ID, collab_title: "Budget app", idle_days: 7 },
    },
    {
      type: "task.assigned",
      payload: {
        collab_id: ID,
        task_id: ID,
        task_title: "Wireframes",
        collab_title: "Budget app",
        assigned_by_name: "Ada",
      },
    },
  ]

  it("has a title for every type, naming the person or the thing", () => {
    expect(samples.map((sample) => sample.type).sort()).toEqual([...NOTIFICATION_TYPES].sort())
    for (const sample of samples) {
      const text = describeNotification(sample)
      expect(text.title.length).toBeGreaterThan(0)
      expect(`${text.title} ${text.detail ?? ""}`).toMatch(/Ada|Bo|Budget app|YouTube|payouts/)
    }
    expect(describeNotification(samples[2] as ParsedNotification).title).toBe(
      "Ada sent you a proposal",
    )
  })
})
