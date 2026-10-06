import { finalizeAgreement } from "@/lib/agreements/finalize"
import { getDb } from "@/lib/db/client"

import { defineJob } from "../define"

/**
 * `agreements/finalize` (§12 "When both have signed"): render the signed agreement PDF from
 * `rendered_body` and the signatures, store it under `agreements/<collabId>/<agreementId>.pdf`, set
 * `pdf_storage_key`, then notify `agreement.completed` to both members with the PDF attached
 * (dedupe key `agreement.completed:<agreementId>:<userId>`). Idempotent: a stored PDF is not
 * rendered again (CLAUDE.md §19.24 "Collabs", §19.28; lib/agreements/finalize.ts).
 *
 * Enqueued after the last signature commits (lib/agreements/sign.ts); the daily `reminders-stalled`
 * run enqueues it again for any signed agreement still without a PDF.
 */
export const agreementsFinalize = defineJob({
  id: "agreements-finalize",
  event: "agreements/finalize.requested",
  retries: 3,
  concurrency: { limit: 1, key: "event.data.agreementId" },
  handler: async ({ data, step }) => finalizeAgreement(getDb(), data.agreementId, step),
})
