import { z } from "zod"

import { parseMoneyInput } from "@/lib/money-input"
import { PRODUCT_FORMAT_VALUES } from "@/lib/profiles/fields"
import { parseTopicsInput, TOPIC_MAX_LENGTH, TOPICS_MAX } from "@/lib/social/summary-form"

/**
 * Field rules shared by the idea and product forms (§5 ideas / products; CLAUDE.md §19.25).
 * Client-safe. Topics use the creator-topic rules (lowercase, `#` and duplicates dropped, ≤ 8;
 * lib/social/summary-form.ts) so ideas, products and creator profiles share one vocabulary for
 * the `topic_overlap` matching feature (§8).
 */

/** ≤ 200 is the W2 contract's cap (notification payloads carry titles); forms keep them short. */
export const SUPPLY_TITLE_MAX = 120
/** €10,000 in cents: these are small digital products. */
export const SUPPLY_PRICE_MAX_CENTS = 1_000_000
export { TOPIC_MAX_LENGTH, TOPICS_MAX }

/** Ideas and products are priced in euros for now (launches default to `eur`, §5). */
export const SUPPLY_CURRENCY = "eur"

/** "Save draft" / "Save" vs "Publish" (the form's submit buttons send `intent`). */
export const SUPPLY_INTENTS = ["save", "publish"] as const
export type SupplyIntent = (typeof SUPPLY_INTENTS)[number]

export const intentSchema = z.enum(SUPPLY_INTENTS).optional().default("save")

/** Trim and collapse whitespace runs (titles). */
export function collapseLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Multi-line text: CRLF → LF, trimmed (browsers submit textareas with CRLF). */
export function normalizeMultiline(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim()
}

export function titleSchema(noun: string) {
  const message = `Give your ${noun} a title.`
  return z
    .string({ error: message })
    .transform(collapseLine)
    .pipe(
      z
        .string()
        .min(1, message)
        .max(SUPPLY_TITLE_MAX, `Keep the title under ${SUPPLY_TITLE_MAX} characters.`),
    )
}

/** Optional multi-line text (Markdown allowed): empty → null. */
export function optionalLongText(max: number, tooLong: string) {
  return z
    .string()
    .optional()
    .transform((value) => {
      const text = normalizeMultiline(value ?? "")
      return text === "" ? null : text
    })
    .pipe(z.string().max(max, tooLong).nullable())
}

/** Optional one-line text: empty → null. */
export function optionalLine(max: number, tooLong: string) {
  return z
    .string()
    .optional()
    .transform((value) => {
      const text = collapseLine(value ?? "")
      return text === "" ? null : text
    })
    .pipe(z.string().max(max, tooLong).nullable())
}

export const formatSchema = z.enum(PRODUCT_FORMAT_VALUES, { error: "Pick a format." })

/** A form value that may be one string, several (repeated fields) or missing, as one string. */
const joinedText = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (Array.isArray(value) ? value.join(",") : (value ?? "")))

/** The tag input's comma list → normalised topics. */
export const topicsSchema = joinedText.pipe(
  z
    .string()
    .max(1000, "That's too many topics.")
    .transform(parseTopicsInput)
    .pipe(
      z
        .array(
          z.string().max(TOPIC_MAX_LENGTH, `Keep each topic under ${TOPIC_MAX_LENGTH} characters.`),
        )
        .max(TOPICS_MAX, `Pick at most ${TOPICS_MAX} topics.`),
    ),
)

/**
 * A price typed in euros ("19", "19.99", "19,99") → integer cents, or null when empty. Numbers
 * are accepted too (tests, the AI brief), as cents.
 */
export const priceSchema = z
  .union([z.string().max(40, "Enter a price like 19 or 19.99."), z.number()])
  .optional()
  .transform((value, context) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || value > SUPPLY_PRICE_MAX_CENTS) {
        context.addIssue({ code: "custom", message: "Enter a price like 19 or 19.99." })
        return z.NEVER
      }
      return value
    }
    const parsed = parseMoneyInput(value ?? "", {
      currency: SUPPLY_CURRENCY,
      max: SUPPLY_PRICE_MAX_CENTS,
    })
    if (parsed.ok) return parsed.cents
    context.addIssue({
      code: "custom",
      message:
        parsed.reason === "too_large"
          ? "Keep the price at €10,000 or less."
          : parsed.reason === "too_many_decimals"
            ? "Use at most two decimals, like 19.99."
            : "Enter a price like 19 or 19.99.",
    })
    return z.NEVER
  })

/** A checkbox: present ("on") when ticked, missing otherwise. Booleans pass through (tests). */
export const checkboxSchema = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "on" || value === "true")

/** Field errors as `defineAction` returns them. */
export type SupplyFieldErrors = Record<string, string[]>
