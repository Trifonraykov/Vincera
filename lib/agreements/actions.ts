"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canSignAgreement } from "@/lib/auth/authz"
import { getDb } from "@/lib/db/client"
import { agreementSignatures, agreements, collabMembers } from "@/lib/db/schema"
import { clientIp } from "@/lib/ratelimit"

import { signAgreementFields } from "./fields"
import { AGREEMENT_MESSAGES, signAgreement } from "./sign"

/**
 * Agreement server actions (§4). The work and the checks under the agreement's lock are in
 * ./sign.ts; `authorize` gives a member a plain reason up front (not found, already complete).
 */

const signInput = z.object(signAgreementFields)

export const signAgreementAction = defineAction({
  name: "agreements.sign",
  input: signInput,
  authorize: async (user, input) => {
    const db = getDb()
    const [agreement] = await db
      .select({ collabId: agreements.collabId, status: agreements.status })
      .from(agreements)
      .where(eq(agreements.id, input.agreementId))
    if (!agreement) throw new ActionError(AGREEMENT_MESSAGES.notFound)
    const members = await db
      .select({ userId: collabMembers.userId })
      .from(collabMembers)
      .where(eq(collabMembers.collabId, agreement.collabId))
    const memberUserIds = members.map((member) => member.userId)
    if (!memberUserIds.includes(user.id)) throw new ActionError(AGREEMENT_MESSAGES.notFound)
    const signatures = await db
      .select({ userId: agreementSignatures.userId })
      .from(agreementSignatures)
      .where(eq(agreementSignatures.agreementId, input.agreementId))
    const signedUserIds = signatures.map((signature) => signature.userId)
    // Already signed: let it through, the service answers idempotently.
    if (signedUserIds.includes(user.id)) return true
    if (agreement.status === "terminated") throw new ActionError(AGREEMENT_MESSAGES.terminated)
    return canSignAgreement(user, { memberUserIds, status: agreement.status, signedUserIds })
  },
  run: async ({ input, user, db }) => {
    const requestHeaders = await headers()
    const result = await signAgreement(db, user, {
      agreementId: input.agreementId,
      typedName: input.typedName,
      bodyHash: input.bodyHash,
      ip: clientIp(requestHeaders),
      userAgent: requestHeaders.get("user-agent"),
    })
    // The collab pages, the home section and the shell's counts all show it.
    revalidatePath("/app", "layout")
    return result
  },
})
