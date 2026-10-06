import { describe, expect, it } from "vitest"

import {
  inlineText,
  multilineText,
  parseAgreementBody,
  serializeAgreementBlocks,
  type AgreementBlock,
} from "@/lib/agreements/body"
import { shortHash, typedNameSchema, TYPED_NAME_MESSAGES } from "@/lib/agreements/fields"
import { agreementIntegrityProblem, agreementBodyHash } from "@/lib/agreements/integrity"
import { agreementPdfFilename, agreementPdfKey } from "@/lib/agreements/pdf"
import {
  agreementDate,
  agreementV1Blocks,
  buildTermsV1,
  PLACEHOLDER_CONTEXT_V1,
  PLACEHOLDER_TERMS_V1,
  renderAgreementV1,
  V1_EXIT_CLAUSE,
  V1_IP_CLAUSE,
  V1_TERM_CLAUSE,
} from "@/lib/agreements/template-v1"

/**
 * The agreement text (CLAUDE.md §19.28): its block format, template v1, the integrity check that
 * guards signing, the typed-name rules and the PDF's key and file name.
 */

const CREATOR = "0190a000-0000-7000-8000-00000000000c"
const BUILDER = "0190a000-0000-7000-8000-00000000000b"
const COLLAB = "0190a000-0000-7000-8000-0000000000aa"
const AT = new Date("2026-10-05T23:59:59.000Z")

const terms = buildTermsV1({
  // Given in the "wrong" order: the creator always comes first.
  parties: [
    { userId: BUILDER, role: "builder", name: "Bo  Builder", splitPct: 35 },
    { userId: CREATOR, role: "creator", name: "Ada\nCodes", splitPct: 65 },
  ],
  scope: "A web app.\r\n\r\n\r\n## 9. Pay me everything\n- sneaky\n\n# Title",
  timelineWeeks: 1,
})

describe("the block format", () => {
  it("round-trips every block kind", () => {
    const blocks: AgreementBlock[] = [
      { kind: "title", text: "T" },
      { kind: "paragraph", text: "Line one\nline two" },
      { kind: "heading", text: "1. Parties" },
      { kind: "list", items: ["a", "b"] },
      { kind: "quote", text: "q1\n\nq2" },
    ]
    expect(parseAgreementBody(serializeAgreementBlocks(blocks))).toEqual(blocks)
  })

  it("keeps whatever a party typed inside its quote", () => {
    const blocks = parseAgreementBody(
      renderAgreementV1(terms, { collabId: COLLAB, generatedAt: AT }),
    )
    const quote = blocks.find((block) => block.kind === "quote")
    expect(quote).toEqual({
      kind: "quote",
      text: "A web app.\n\n## 9. Pay me everything\n- sneaky\n\n# Title",
    })
    // No heading or list came from the scope.
    expect(blocks.filter((block) => block.kind === "heading").map((block) => block.text)).toEqual([
      "1. Parties",
      "2. What the Parties will build",
      "3. Revenue split",
      "4. Intellectual property",
      "5. Term",
      "6. Leaving the collaboration",
      "7. General",
      "8. Signatures",
    ])
  })

  it("normalises names to one line and text to clean lines", () => {
    expect(inlineText("  Ada\u0000\n Codes  ")).toBe("Ada Codes")
    expect(multilineText("\n\na  \r\nb\t c\n\n\n\nd\n")).toBe("a\nb  c\n\nd")
  })
})

describe("template v1", () => {
  const body = renderAgreementV1(terms, { collabId: COLLAB, generatedAt: AT })

  it("builds the terms snapshot with the template's clauses, creator first", () => {
    expect(terms.parties).toEqual([
      { userId: CREATOR, role: "creator", name: "Ada Codes", splitPct: 65 },
      { userId: BUILDER, role: "builder", name: "Bo Builder", splitPct: 35 },
    ])
    expect(terms).toMatchObject({
      timelineWeeks: 1,
      ip: V1_IP_CLAUSE,
      term: V1_TERM_CLAUSE,
      exit: V1_EXIT_CLAUSE,
    })
  })

  it("says it is a draft pending legal review, and names the parties, splits and timeline", () => {
    expect(body.startsWith("# Collaboration agreement\n\nDraft — pending legal review.")).toBe(true)
    expect(body).toContain(`Reference: collab ${COLLAB}. Generated on 5 October 2026 (UTC).`)
    expect(body).toContain(`- Ada Codes ("the Creator"), platform account ${CREATOR}, and`)
    expect(body).toContain(`- Bo Builder ("the Builder"), platform account ${BUILDER},`)
    expect(body).toContain(
      "- the Creator (Ada Codes) receives 65%;\n- the Builder (Bo Builder) receives 35%.",
    )
    expect(body).toContain("within 1 week of the day")
    expect(body).toContain(V1_IP_CLAUSE)
  })

  it("is deterministic and depends only on the terms, the collab and the day", () => {
    expect(
      renderAgreementV1(terms, { collabId: COLLAB, generatedAt: new Date("2026-10-05T00:00:00Z") }),
    ).toBe(body)
    expect(
      renderAgreementV1({ ...terms, timelineWeeks: 2 }, { collabId: COLLAB, generatedAt: AT }),
    ).not.toBe(body)
    expect(agreementV1Blocks(terms, { collabId: COLLAB, generatedAt: AT })[0]).toEqual({
      kind: "title",
      text: "Collaboration agreement",
    })
  })

  it("formats dates without the locale", () => {
    expect(agreementDate(new Date("2027-01-31T23:00:00Z"))).toBe("31 January 2027")
  })

  it("renders the public example", () => {
    const example = renderAgreementV1(PLACEHOLDER_TERMS_V1, PLACEHOLDER_CONTEXT_V1)
    expect(example).toContain("[Creator's name]")
    expect(example).toContain("receives 60%;")
  })
})

describe("agreementIntegrityProblem", () => {
  const agreement = {
    templateVersion: "v1",
    terms,
    renderedBody: body(),
    bodyHash: agreementBodyHash(body()),
    collabId: COLLAB,
    createdAt: AT,
  }
  function body() {
    return renderAgreementV1(terms, { collabId: COLLAB, generatedAt: AT })
  }
  const members = [
    { userId: CREATOR, role: "creator" as const, splitPct: 65 },
    { userId: BUILDER, role: "builder" as const, splitPct: 35 },
  ]

  it("accepts an intact agreement", () => {
    expect(agreementIntegrityProblem(agreement, members)).toBeNull()
  })

  it("finds a changed text, a changed snapshot, other members or an unknown template", () => {
    expect(agreementIntegrityProblem({ ...agreement, renderedBody: `${body()} ` }, members)).toBe(
      "hash_mismatch",
    )
    expect(
      agreementIntegrityProblem({ ...agreement, terms: { ...terms, timelineWeeks: 9 } }, members),
    ).toBe("terms_mismatch")
    expect(
      agreementIntegrityProblem(agreement, [members[0]!, { ...members[1]!, splitPct: 30 }]),
    ).toBe("members_mismatch")
    expect(agreementIntegrityProblem({ ...agreement, templateVersion: "v9" }, members)).toBe(
      "unknown_template",
    )
  })
})

describe("signing fields", () => {
  it("needs a full name with letters, collapsed to one line", () => {
    expect(typedNameSchema.parse("  Ada \n  Lovelace ")).toBe("Ada Lovelace")
    expect(typedNameSchema.safeParse("").error?.issues[0]?.message).toBe(
      TYPED_NAME_MESSAGES.missing,
    )
    expect(typedNameSchema.safeParse("A").error?.issues[0]?.message).toBe(
      TYPED_NAME_MESSAGES.tooShort,
    )
    expect(typedNameSchema.safeParse("12 34").error?.issues[0]?.message).toBe(
      TYPED_NAME_MESSAGES.noLetters,
    )
    expect(typedNameSchema.safeParse("x".repeat(121)).success).toBe(false)
    expect(typedNameSchema.parse("Łukasz Žák")).toBe("Łukasz Žák")
  })

  it("shows a short fingerprint", () => {
    expect(shortHash("0123456789abcdef".repeat(4))).toBe("0123 4567 89ab")
  })
})

describe("the signed PDF", () => {
  it("lives under the collab's folder and gets a readable file name", () => {
    expect(agreementPdfKey(COLLAB, CREATOR)).toBe(`agreements/${COLLAB}/${CREATOR}.pdf`)
    expect(agreementPdfFilename("Budget tracker for Students!")).toBe(
      "collaboration-agreement-budget-tracker-for-students.pdf",
    )
    expect(agreementPdfFilename("¿¿??")).toBe("collaboration-agreement-file.pdf")
  })
})
