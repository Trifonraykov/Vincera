import { z } from "zod"

import { inlineText } from "./body"

/**
 * The signing form's fields (§12 "Sign requires typing your full name"). Client-safe: the form and
 * the server action share the rules.
 */

export const TYPED_NAME_MAX = 120

export const TYPED_NAME_MESSAGES = {
  missing: "Type your full name to sign.",
  tooShort: "Type your full name, as on an ID document.",
  tooLong: `Your name can be at most ${TYPED_NAME_MAX} characters.`,
  noLetters: "Type your full name using letters.",
} as const

/** The typed name as it is stored: one line, whitespace collapsed (NFC). */
export const typedNameSchema = z
  .string({ error: TYPED_NAME_MESSAGES.missing })
  .transform((value) => inlineText(value))
  .pipe(
    z
      .string()
      .min(1, { error: TYPED_NAME_MESSAGES.missing, abort: true })
      .min(2, { error: TYPED_NAME_MESSAGES.tooShort, abort: true })
      .max(TYPED_NAME_MAX, TYPED_NAME_MESSAGES.tooLong)
      .regex(/\p{L}/u, TYPED_NAME_MESSAGES.noLetters),
  )

/** A SHA-256 hex digest (the agreement text the signer was shown). */
export const bodyHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "Reload the page and read the agreement again." })

export const signAgreementFields = {
  agreementId: z.uuid({ error: "That agreement link is not valid." }),
  bodyHash: bodyHashSchema,
  typedName: typedNameSchema,
}

/** The short fingerprint shown next to the text: the first 12 hex characters, grouped by 4. */
export function shortHash(hash: string): string {
  return (
    hash
      .slice(0, 12)
      .match(/.{1,4}/g)
      ?.join(" ") ?? hash
  )
}
