import "server-only"

import type { AgreementTerms, CollabRole } from "@/lib/db/schema"
import { sha256Hex } from "@/lib/crypto"

import { AGREEMENT_TEMPLATE_V1, renderAgreementV1 } from "./template-v1"

/**
 * Before anyone signs (§12, CLAUDE.md §19.28 "Integrity"), the stored agreement must still be the
 * one that was generated from the deal:
 *
 * 1. `body_hash` is the SHA-256 of `rendered_body` (the database checks it too);
 * 2. re-rendering the template from the `terms` snapshot gives exactly `rendered_body`, so the
 *    snapshot was not changed after the text was generated;
 * 3. the parties in the snapshot are the collab's members with the same roles and splits, so the
 *    split the ledger will pay (`collab_members.split_pct`, §9) is the split being signed.
 *
 * The signer's own check (the hash of the text they were shown equals `body_hash`) is separate:
 * it catches a page that went stale, not tampering.
 */

export type AgreementForIntegrity = {
  templateVersion: string
  terms: AgreementTerms
  renderedBody: string
  bodyHash: string
  collabId: string
  createdAt: Date
}

export type MemberForIntegrity = { userId: string; role: CollabRole; splitPct: number }

export type IntegrityProblem =
  "unknown_template" | "hash_mismatch" | "terms_mismatch" | "members_mismatch"

export function agreementBodyHash(body: string): string {
  return sha256Hex(body)
}

/** Re-renders the agreement's template from its terms (null for an unknown template version). */
export function rerenderAgreement(agreement: AgreementForIntegrity): string | null {
  if (agreement.templateVersion !== AGREEMENT_TEMPLATE_V1) return null
  return renderAgreementV1(agreement.terms, {
    collabId: agreement.collabId,
    generatedAt: agreement.createdAt,
  })
}

/** Null when the agreement is intact, else what is wrong (never shown to users verbatim). */
export function agreementIntegrityProblem(
  agreement: AgreementForIntegrity,
  members: readonly MemberForIntegrity[],
): IntegrityProblem | null {
  if (agreementBodyHash(agreement.renderedBody) !== agreement.bodyHash) return "hash_mismatch"
  const rendered = rerenderAgreement(agreement)
  if (rendered === null) return "unknown_template"
  if (rendered !== agreement.renderedBody) return "terms_mismatch"

  const key = (party: MemberForIntegrity) => `${party.userId}:${party.role}:${party.splitPct}`
  const expected = members.map(key).sort()
  const actual = agreement.terms.parties.map(key).sort()
  if (expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) {
    return "members_mismatch"
  }
  return null
}
