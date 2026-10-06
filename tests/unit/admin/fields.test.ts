import { describe, expect, it } from "vitest"

import { adminNote, parseSignedCents } from "@/lib/admin/fields"

/** Admin form helpers (Phase 6; CLAUDE.md §19.39). */

describe("parseSignedCents", () => {
  it.each([
    ["5", 500],
    ["-5", -500],
    ["−5", -500],
    ["12.5", 1250],
    ["12,05", 1205],
    ["+3.20", 320],
    ["€ 7", 700],
    ["0", 0],
  ])("%s → %s", (raw, cents) => {
    expect(parseSignedCents(raw)).toBe(cents)
  })

  it.each(["", "abc", "1.234", "5-", "--5", "1e3", "1234567"])("refuses %j", (raw) => {
    expect(parseSignedCents(raw)).toBeNull()
  })
})

describe("adminNote", () => {
  const note = adminNote(20, "Required.")

  it("trims, requires and caps the text", () => {
    expect(note.parse("  ok  ")).toBe("ok")
    expect(note.safeParse("   ").success).toBe(false)
    expect(note.safeParse("x".repeat(21)).success).toBe(false)
  })

  it("refuses email addresses (the note is kept in the audit log)", () => {
    expect(note.safeParse("a@example.com").success).toBe(false)
  })
})
