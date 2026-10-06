import type { AgreementTerms, CollabRole } from "@/lib/db/schema"

import { inlineText, multilineText, serializeAgreementBlocks, type AgreementBlock } from "./body"

/**
 * The standard collaboration agreement, version 1 (§12 "Agreement page", §18.2). Both members of
 * a collab click-sign it before work starts.
 *
 * **Draft, pending legal review** (§18.2: IP ownership, exit and buyout terms and governing law
 * need a Spanish/EU lawyer before real money flows). The text says so itself, so the notice is
 * part of what is signed.
 *
 * `renderAgreementV1(terms, context)` produces the canonical text (lib/agreements/body.ts) that is
 * stored as `agreements.rendered_body`, hashed into `body_hash`, shown on the agreement page and
 * printed in the PDF. It depends only on the terms snapshot and on immutable facts of the
 * agreement (the collab id and the generation day), so signing can re-render it and prove the
 * snapshot was not changed after generation (lib/agreements/integrity.ts). Pure and client-safe;
 * deterministic (no locale-dependent formatting).
 *
 * A changed text is a new template version (`template-v2.tsx`, `template_version = 'v2'`);
 * agreements already generated keep their stored text.
 */

export const AGREEMENT_TEMPLATE_V1 = "v1"

/** Clause 4: who owns what. */
export const V1_IP_CLAUSE =
  "Each Party keeps what they owned before this agreement or create outside it: the Creator their name, likeness, brand, content and audience; the Builder their existing code, tools and know-how. Each Party lets the other use those existing materials, without charge and not exclusively, only as far as needed to build, market and sell the Product while this agreement is in force. The Product itself (the code, design, name and content made for it under this agreement) is owned by both Parties together. Neither Party may sell, license or transfer the Product, or their part of it, without the other Party's written consent given on the Platform."

/** Clause 5: how long the agreement runs. */
export const V1_TERM_CLAUSE =
  "This agreement starts when both Parties have signed it and continues for as long as the Product is sold on the Platform, unless it ends earlier under section 6."

/** Clause 6: leaving. */
export const V1_EXIT_CLAUSE =
  "Before the Product launches, either Party may end this agreement by giving 14 days' notice through the Platform's messages; nothing is owed for work done so far, and each Party keeps their existing materials. After the Product launches, a Party who leaves keeps receiving their share of sales made in the 12 months after their notice period ends, unless the Parties agree a buyout in writing on the Platform; the Product stays on sale only while both Parties agree. If a Party seriously breaks this agreement and does not put it right within 14 days of being asked to, the other Party may ask the Platform to review the collaboration through its dispute process."

export type AgreementParty = AgreementTerms["parties"][number]

export type AgreementContext = {
  /** The collab's id: the agreement's reference. */
  collabId: string
  /** When the agreement was generated (`agreements.created_at`); only the UTC day is printed. */
  generatedAt: Date
}

/** How each party is named in the text. */
const PARTY_TERMS: Record<CollabRole, string> = { creator: "the Creator", builder: "the Builder" }

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

/** "5 October 2026" in UTC, without Intl (the text must render identically everywhere). */
export function agreementDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

function weeks(count: number): string {
  return count === 1 ? "1 week" : `${count} weeks`
}

/** The parties in agreement order: the creator first, then the builder. */
export function orderParties(parties: readonly AgreementParty[]): AgreementParty[] {
  const rank: Record<CollabRole, number> = { creator: 0, builder: 1 }
  return [...parties].sort((a, b) => rank[a.role] - rank[b.role])
}

/**
 * The v1 terms snapshot (§5 `agreements.terms`): the parties with their names and splits (from
 * `collab_members`), the scope and timeline of the accepted proposal revision, and the template's
 * IP, term and exit clauses.
 */
export function buildTermsV1(input: {
  parties: readonly AgreementParty[]
  scope: string
  timelineWeeks: number
}): AgreementTerms {
  return {
    parties: orderParties(input.parties).map((party) => ({
      userId: party.userId,
      role: party.role,
      name: inlineText(party.name),
      splitPct: party.splitPct,
    })),
    scope: multilineText(input.scope),
    timelineWeeks: input.timelineWeeks,
    ip: V1_IP_CLAUSE,
    term: V1_TERM_CLAUSE,
    exit: V1_EXIT_CLAUSE,
  }
}

/** The agreement as blocks (see `renderAgreementV1`). */
export function agreementV1Blocks(
  terms: AgreementTerms,
  context: AgreementContext,
): AgreementBlock[] {
  const parties = orderParties(terms.parties)
  const last = parties.length - 1
  const partyLines = parties.map(
    (party, index) =>
      `${inlineText(party.name)} ("${PARTY_TERMS[party.role]}"), platform account ${party.userId}${index < last ? ", and" : ","}`,
  )
  const splitLines = parties.map(
    (party, index) =>
      `${PARTY_TERMS[party.role]} (${inlineText(party.name)}) receives ${party.splitPct}%${index < last ? ";" : "."}`,
  )

  return [
    { kind: "title", text: "Collaboration agreement" },
    {
      kind: "paragraph",
      text: `Draft — pending legal review. This is version ${AGREEMENT_TEMPLATE_V1} of the Platform's standard collaboration agreement. It has not been reviewed by a lawyer yet and will be replaced by a reviewed version before real money flows through the Platform.`,
    },
    {
      kind: "paragraph",
      text: `Reference: collab ${context.collabId}. Generated on ${agreementDate(context.generatedAt)} (UTC).`,
    },

    { kind: "heading", text: "1. Parties" },
    { kind: "paragraph", text: "This agreement is between:" },
    { kind: "list", items: partyLines },
    {
      kind: "paragraph",
      text: 'together "the Parties". They met through the online platform on which this agreement is signed ("the Platform"). Each Party confirms who they are by typing their full legal name when they sign.',
    },

    { kind: "heading", text: "2. What the Parties will build" },
    {
      kind: "paragraph",
      text: 'The Parties will work together to build and sell the digital product described below ("the Product"), as agreed in the proposal they accepted on the Platform:',
    },
    { kind: "quote", text: terms.scope },
    {
      kind: "paragraph",
      text: `The Parties aim to have the Product ready to launch within ${weeks(terms.timelineWeeks)} of the day this agreement is fully signed. This timeline is a shared goal: missing it does not end the agreement.`,
    },

    { kind: "heading", text: "3. Revenue split" },
    {
      kind: "paragraph",
      text: "The Product is sold only through the Platform. For each sale, the Platform first deducts the taxes collected on the sale, the payment processor's fee and the Platform's fee as set out in the Platform's terms. What remains is divided between the Parties:",
    },
    { kind: "list", items: splitLines },
    {
      kind: "paragraph",
      text: "The Platform calculates each share automatically, holds it for the period set out in its terms to cover refunds and chargebacks, and then pays it to each Party's connected payout account. Refunds and chargebacks reduce both shares in the same proportion.",
    },

    { kind: "heading", text: "4. Intellectual property" },
    { kind: "paragraph", text: terms.ip },

    { kind: "heading", text: "5. Term" },
    { kind: "paragraph", text: terms.term },

    { kind: "heading", text: "6. Leaving the collaboration" },
    { kind: "paragraph", text: terms.exit },

    { kind: "heading", text: "7. General" },
    {
      kind: "list",
      items: [
        "Changes to this agreement need both Parties' consent, recorded on the Platform as a new agreement.",
        "The Parties discuss the Product through the Platform's messages, which both of them can read.",
        "If the Parties disagree, they first try to settle it between themselves, then through the Platform's dispute process.",
        "The governing law and the competent courts will be set out in the reviewed version of this agreement.",
      ],
    },

    { kind: "heading", text: "8. Signatures" },
    {
      kind: "paragraph",
      text: "Each Party signs by typing their full name on the Platform. The Platform records the time, IP address and browser of each signature together with the SHA-256 fingerprint of this text, and sends both Parties a PDF copy once both have signed.",
    },
  ]
}

/** The canonical agreement text for `terms` (stored as `rendered_body`, hashed into `body_hash`). */
export function renderAgreementV1(terms: AgreementTerms, context: AgreementContext): string {
  return serializeAgreementBlocks(agreementV1Blocks(terms, context))
}

/** Example terms for the public `/legal/agreement` page. */
export const PLACEHOLDER_TERMS_V1: AgreementTerms = buildTermsV1({
  parties: [
    {
      userId: "00000000-0000-7000-8000-000000000001",
      role: "creator",
      name: "[Creator's name]",
      splitPct: 60,
    },
    {
      userId: "00000000-0000-7000-8000-000000000002",
      role: "builder",
      name: "[Builder's name]",
      splitPct: 40,
    },
  ],
  scope:
    "[What the Parties will build, copied from the accepted proposal. For example: a web app that turns a weekly budget into a meal plan and a shopping list.]",
  timelineWeeks: 6,
})

export const PLACEHOLDER_CONTEXT_V1: AgreementContext = {
  collabId: "00000000-0000-7000-8000-000000000000",
  generatedAt: new Date("2026-01-01T00:00:00.000Z"),
}
