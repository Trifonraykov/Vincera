import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  AGREEMENT_FONT_DIR,
  AgreementFontMissingError,
  agreementFontFiles,
  renderAgreementPdf,
} from "@/lib/agreements/pdf"

/**
 * The signed agreement PDF (CLAUDE.md §19.28, §19.30): set in the committed Geist fonts (never a
 * silent Helvetica fallback, which cannot encode "Łukasz Żółć" or "Анна"), and the fonts are
 * traced into every function that renders it.
 */

const HASH = "a".repeat(64)

describe("renderAgreementPdf", () => {
  it("embeds Geist for names outside Latin-1", async () => {
    const bytes = await renderAgreementPdf({
      agreementId: "01900000-0000-7000-8000-000000000001",
      body: "# Collaboration agreement\n\nBetween Łukasz Żółć and Анна Петрова.",
      bodyHash: HASH,
      signatures: [
        {
          userId: "01900000-0000-7000-8000-000000000002",
          role: "creator",
          typedName: "Łukasz Żółć",
          signedAt: new Date("2026-10-05T12:00:00.000Z"),
          bodyHash: HASH,
        },
        {
          userId: "01900000-0000-7000-8000-000000000003",
          role: "builder",
          typedName: "Анна Петрова",
          signedAt: new Date("2026-10-05T13:00:00.000Z"),
          bodyHash: HASH,
        },
      ],
    })
    const text = bytes.toString("latin1")
    expect(text.startsWith("%PDF-")).toBe(true)
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+Geist/)
    expect(text).not.toContain("Helvetica")
  })

  it("refuses to render without its fonts instead of falling back", () => {
    expect(() => agreementFontFiles(path.join(process.cwd(), "no-such-fonts"))).toThrow(
      AgreementFontMissingError,
    )
    expect(agreementFontFiles().regular).toContain(AGREEMENT_FONT_DIR)
  })

  it("traces the fonts into the functions that render the PDF", () => {
    const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8")
    for (const route of ["/api/inngest", "/app/collabs/[id]/agreement", "/api/test/jobs/[name]"]) {
      expect(config).toContain(`"${route}": ["./lib/agreements/fonts/*.ttf"]`)
    }
  })
})
