import { describe, expect, it } from "vitest"

import {
  EventPiiError,
  findPii,
  isForbiddenPropertyKey,
  looksLikeEmail,
  scrubPii,
} from "@/lib/events/pii"

describe("isForbiddenPropertyKey", () => {
  it.each([
    "email",
    "buyer_email",
    "buyerEmail",
    "EMAIL_ADDRESS",
    "body",
    "message_body",
    "token",
    "access_token",
    "refreshToken",
    "password",
    "password_hash",
    "client-secret",
    "cookie",
    "authorization",
    "phone",
  ])("flags %s", (key) => {
    expect(isForbiddenPropertyKey(key)).toBe(true)
  })

  it.each([
    "method",
    "attachment_count",
    "thread_kind",
    "input_tokens",
    "somebody",
    "emailed_count_total_x",
    "tokenizer",
    "template_version",
  ])("allows %s", (key) => {
    expect(isForbiddenPropertyKey(key)).toBe(false)
  })
})

describe("looksLikeEmail", () => {
  it("finds an address inside text", () => {
    expect(looksLikeEmail("a@b.co")).toBe(true)
    expect(looksLikeEmail("write to First.Last+tag@example.co.uk please")).toBe(true)
  })

  it("ignores handles and plain values", () => {
    expect(looksLikeEmail("@creator")).toBe(false)
    expect(looksLikeEmail("v0")).toBe(false)
    expect(looksLikeEmail("user@localhost")).toBe(false)
  })
})

describe("findPii / scrubPii", () => {
  const properties = {
    method: "email",
    nested: { access_token: "tok_value_123", ok: 1, list: ["fine", "x@example.com"] },
    buyer_email: "b@example.com",
  }

  it("reports every offending path, without values", () => {
    expect(findPii(properties)).toEqual([
      { path: "nested.access_token", reason: "key" },
      { path: "nested.list[1]", reason: "email_value" },
      { path: "buyer_email", reason: "key" },
    ])
    expect(findPii({ method: "email", count: 3, flag: true, none: null })).toEqual([])
  })

  it("removes forbidden keys and redacts email-like values", () => {
    expect(scrubPii(properties)).toEqual({
      method: "email",
      nested: { ok: 1, list: ["fine", "[redacted]"] },
    })
  })

  it("builds an error that names paths but never values", () => {
    const error = new EventPiiError("order.paid", findPii(properties))
    expect(error.message).toContain("buyer_email")
    expect(error.message).not.toContain("b@example.com")
    expect(error.message).not.toContain("tok_value_123")
  })
})
