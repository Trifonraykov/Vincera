import "server-only"

import { canViewCollab, type AuthzUser } from "@/lib/auth/authz"
import { loadCollabAccess, loadCollabTitle } from "@/lib/collabs/queries"
import type { DbOrTx } from "@/lib/db/client"
import { getStorage } from "@/lib/storage/r2"
import type { ObjectStorage } from "@/lib/storage/types"

import { agreementPdfFilename, agreementPdfKey } from "./pdf"
import { loadAgreementFile } from "./queries"

/** Signed agreement downloads expire after 5 minutes (§12, §14). */
export const AGREEMENT_PDF_URL_TTL_SECONDS = 5 * 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })
}

/**
 * `GET /api/agreements/<agreementId>/pdf`: a redirect (302) to a 5-minute signed URL that downloads
 * the signed PDF, for the collab's members and admins (`canViewCollab`, §6). Everything else
 * (signed out, strangers, an agreement without a PDF yet, a key outside its collab's folder)
 * answers 404, so the route reveals nothing about which agreements exist.
 */
export async function agreementPdfResponse(
  input: { agreementId: string },
  deps: { db: DbOrTx; user: AuthzUser | null; storage?: ObjectStorage },
): Promise<Response> {
  if (!deps.user || !UUID_PATTERN.test(input.agreementId)) return notFound()
  const agreement = await loadAgreementFile(deps.db, input.agreementId)
  if (!agreement?.pdfStorageKey) return notFound()
  const collab = await loadCollabAccess(deps.db, agreement.collabId)
  if (!collab || !canViewCollab(deps.user, collab)) return notFound()
  if (agreement.pdfStorageKey !== agreementPdfKey(agreement.collabId, agreement.id)) {
    return notFound()
  }
  const filename = agreementPdfFilename(await loadCollabTitle(deps.db, agreement.collabId))
  const url = await (deps.storage ?? getStorage()).signedGetUrl(agreement.pdfStorageKey, {
    expiresInSeconds: AGREEMENT_PDF_URL_TTL_SECONDS,
    filename,
  })
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": `private, max-age=${Math.floor(AGREEMENT_PDF_URL_TTL_SECONDS / 2)}`,
      "Referrer-Policy": "no-referrer",
    },
  })
}
