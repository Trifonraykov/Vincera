import "server-only"

import { and, asc, eq, ne } from "drizzle-orm"

import type { DbOrTx } from "@/lib/db/client"
import {
  agreementSignatures,
  agreements,
  type AgreementStatus,
  type AgreementTerms,
} from "@/lib/db/schema"

/**
 * Reads for the agreement page (§12 `/app/collabs/[id]/agreement`). Callers authorize with
 * `canViewCollab` first; the signatures' IP and browser are only in the PDF both members receive.
 */

export type AgreementView = {
  id: string
  collabId: string
  status: AgreementStatus
  templateVersion: string
  terms: AgreementTerms
  renderedBody: string
  bodyHash: string
  createdAt: Date
  completedAt: Date | null
  pdfStorageKey: string | null
  signatures: { userId: string; typedName: string; signedAt: Date }[]
}

/** The collab's agreement in force (awaiting signatures or signed), or null. */
export async function loadActiveAgreement(
  database: DbOrTx,
  collabId: string,
): Promise<AgreementView | null> {
  const [row] = await database
    .select({
      id: agreements.id,
      collabId: agreements.collabId,
      status: agreements.status,
      templateVersion: agreements.templateVersion,
      terms: agreements.terms,
      renderedBody: agreements.renderedBody,
      bodyHash: agreements.bodyHash,
      createdAt: agreements.createdAt,
      completedAt: agreements.completedAt,
      pdfStorageKey: agreements.pdfStorageKey,
    })
    .from(agreements)
    .where(and(eq(agreements.collabId, collabId), ne(agreements.status, "terminated")))
  if (!row) return null
  const signatures = await database
    .select({
      userId: agreementSignatures.userId,
      typedName: agreementSignatures.typedName,
      signedAt: agreementSignatures.signedAt,
    })
    .from(agreementSignatures)
    .where(eq(agreementSignatures.agreementId, row.id))
    .orderBy(asc(agreementSignatures.signedAt))
  return { ...row, signatures }
}

/** The agreement row the PDF route needs (any status), or null. */
export async function loadAgreementFile(
  database: DbOrTx,
  agreementId: string,
): Promise<{ id: string; collabId: string; pdfStorageKey: string | null } | null> {
  const [row] = await database
    .select({
      id: agreements.id,
      collabId: agreements.collabId,
      pdfStorageKey: agreements.pdfStorageKey,
    })
    .from(agreements)
    .where(eq(agreements.id, agreementId))
  return row ?? null
}
