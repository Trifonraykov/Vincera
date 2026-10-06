import { z } from "zod"

/**
 * Tracked link form rules (client-safe; §10, CLAUDE.md §19.31, §19.38): a label (≤ 80) and an
 * optional discount code (uppercase letters and digits, 4–20, unique platform-wide) with its
 * percentage off (1–100, whole numbers).
 */

export const LINK_LABEL_MAX = 80
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9]{4,20}$/

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value)
const optional = (value: unknown) => {
  const v = trimmed(value)
  return v === "" || v === undefined || v === null ? undefined : v
}

export const linkLabelSchema = z.preprocess(
  trimmed,
  z
    .string({ error: "Give the link a name." })
    .min(1, { error: "Give the link a name." })
    .max(LINK_LABEL_MAX, { error: `Keep the name under ${LINK_LABEL_MAX} characters.` }),
)

/** Typed codes are uppercased and spaces dropped ("summer 20" → "SUMMER20"). */
export const discountCodeSchema = z.preprocess(
  (value) => {
    const v = optional(value)
    return typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v
  },
  z
    .string()
    .regex(DISCOUNT_CODE_PATTERN, {
      error: "Use 4 to 20 letters and digits, like SUMMER20.",
    })
    .optional(),
)

export const discountPercentSchema = z.preprocess(
  (value) => {
    const v = optional(value)
    return typeof v === "string" ? Number(v.replace(/%$/, "").trim()) : v
  },
  z
    .number({ error: "Enter a whole number from 1 to 100." })
    .int({ error: "Enter a whole number from 1 to 100." })
    .min(1, { error: "Enter a whole number from 1 to 100." })
    .max(100, { error: "Enter a whole number from 1 to 100." })
    .optional(),
)

export const createLinkSchema = z
  .object({
    launchId: z.uuid({ error: "That launch link is not valid." }),
    label: linkLabelSchema,
    discountCode: discountCodeSchema,
    discountPercent: discountPercentSchema,
  })
  .superRefine((value, ctx) => {
    if (value.discountCode && value.discountPercent === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["discountPercent"],
        message: "How much off? Enter a whole number from 1 to 100.",
      })
    }
    if (!value.discountCode && value.discountPercent !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["discountCode"],
        message: "Add a code for the discount, or leave the percentage empty.",
      })
    }
  })

export type CreateLinkInput = z.output<typeof createLinkSchema>

export const renameLinkSchema = z.object({
  linkId: z.uuid({ error: "That link is not valid." }),
  label: linkLabelSchema,
})

export const disableLinkSchema = z.object({
  linkId: z.uuid({ error: "That link is not valid." }),
})

/** The product page with a discount pre-applied (`/p/<slug>?code=<CODE>`, §19.31). */
export function discountPath(slug: string, code: string): string {
  return `/p/${slug}?code=${encodeURIComponent(code)}`
}
