import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import type { JobStep } from "@/inngest/define"
import { notifyAgreementCompleted } from "@/lib/collabs/notifications"
import { loadCollabTitle } from "@/lib/collabs/queries"
import type { DbOrTx } from "@/lib/db/client"
import { agreementSignatures, agreements, collabMembers, type CollabRole } from "@/lib/db/schema"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { agreementPdfFilename, agreementPdfKey, renderAgreementPdf } from "./pdf"

/**
 * `agreements-finalize` (§12 "When both have signed", CLAUDE.md §19.24): after the last signature
 * commits, render the signed PDF, store it at `agreements/<collabId>/<agreementId>.pdf`, set
 * `pdf_storage_key`, then send `agreement.completed` to both members with the PDF attached.
 *
 * Idempotent in both steps: a stored PDF is never rendered again (the key is set once, with a
 * conditional update), and the notifications carry dedupe keys
 * (`agreement.completed:<agreementId>:<userId>`), so a retried or repeated run sends nothing twice.
 */

export type FinalizeOutcome =
  | { skipped: "not_found" | "not_signed" }
  | { pdfStorageKey: string; rendered: boolean; notified: number }

const ROLE_ORDER: Record<CollabRole, number> = { creator: 0, builder: 1 }

async function loadSignedAgreement(database: DbOrTx, agreementId: string) {
  const [agreement] = await database
    .select({
      id: agreements.id,
      collabId: agreements.collabId,
      status: agreements.status,
      renderedBody: agreements.renderedBody,
      bodyHash: agreements.bodyHash,
      completedAt: agreements.completedAt,
      pdfStorageKey: agreements.pdfStorageKey,
      terms: agreements.terms,
    })
    .from(agreements)
    .where(eq(agreements.id, agreementId))
  return agreement ?? null
}

/** Step 1: the PDF in storage and its key on the row. Null when there is nothing to finalize. */
export async function storeAgreementPdf(
  database: DbOrTx,
  agreementId: string,
  storage: ObjectStorage = getStorage(),
): Promise<{ pdfStorageKey: string; rendered: boolean } | { skipped: "not_found" | "not_signed" }> {
  const agreement = await loadSignedAgreement(database, agreementId)
  if (!agreement) return { skipped: "not_found" }
  if (agreement.status !== "signed" || !agreement.completedAt) return { skipped: "not_signed" }
  if (agreement.pdfStorageKey) return { pdfStorageKey: agreement.pdfStorageKey, rendered: false }

  const signatures = await database
    .select({
      userId: agreementSignatures.userId,
      typedName: agreementSignatures.typedName,
      signedAt: agreementSignatures.signedAt,
      bodyHash: agreementSignatures.bodyHash,
      role: collabMembers.role,
    })
    .from(agreementSignatures)
    .innerJoin(
      collabMembers,
      and(
        eq(collabMembers.collabId, agreement.collabId),
        eq(collabMembers.userId, agreementSignatures.userId),
      ),
    )
    .where(eq(agreementSignatures.agreementId, agreement.id))
  signatures.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])

  const key = agreementPdfKey(agreement.collabId, agreement.id)
  const bytes = await renderAgreementPdf({
    agreementId: agreement.id,
    body: agreement.renderedBody,
    bodyHash: agreement.bodyHash,
    signatures,
  })
  // Same key on a retry: the object is simply written again before the row points at it.
  await storage.putObject(key, bytes, "application/pdf")
  const updated = await database
    .update(agreements)
    .set({ pdfStorageKey: key })
    .where(and(eq(agreements.id, agreement.id), isNull(agreements.pdfStorageKey)))
    .returning({ key: agreements.pdfStorageKey })
  if (updated.length === 0) {
    // A concurrent run stored it first; keep its key.
    const current = await loadSignedAgreement(database, agreementId)
    return { pdfStorageKey: current?.pdfStorageKey ?? key, rendered: false }
  }
  return { pdfStorageKey: key, rendered: true }
}

/** Step 2: `agreement.completed` to each member, with the stored PDF attached. */
export async function emailSignedAgreement(
  database: DbOrTx,
  agreementId: string,
  storage: ObjectStorage = getStorage(),
): Promise<number> {
  const agreement = await loadSignedAgreement(database, agreementId)
  if (!agreement?.pdfStorageKey || !agreement.completedAt) return 0
  const file = await storage.getObject(agreement.pdfStorageKey)
  if (!file) throw new Error(`agreements-finalize: PDF missing from storage for ${agreementId}`)
  const collabTitle = await loadCollabTitle(database, agreement.collabId)
  const filename = agreementPdfFilename(collabTitle)
  let notified = 0
  for (const party of agreement.terms.parties) {
    const counterpart = agreement.terms.parties.find((other) => other.userId !== party.userId)
    await notifyAgreementCompleted(database, {
      userId: party.userId,
      collabId: agreement.collabId,
      agreementId: agreement.id,
      collabTitle,
      counterpartName: counterpart?.name ?? "your collaborator",
      completedAt: agreement.completedAt,
      pdf: { filename, content: file.body, contentType: "application/pdf" },
    })
    notified += 1
  }
  return notified
}

/** The whole job: store, then email, each as its own step (retried separately under Inngest). */
export async function finalizeAgreement(
  database: DbOrTx,
  agreementId: string,
  step: JobStep = { run: async (_id, fn) => fn() },
  storage?: ObjectStorage,
): Promise<FinalizeOutcome> {
  const stored = await step.run("store-pdf", () =>
    storeAgreementPdf(database, agreementId, storage),
  )
  if ("skipped" in stored) return stored
  const notified = await step.run("email-members", () =>
    emailSignedAgreement(database, agreementId, storage),
  )
  return { ...stored, notified }
}
