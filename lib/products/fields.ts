import { z } from "zod"

import type { ProductStage } from "@/lib/db/schema/enums"
import { normalizeWebUrl } from "@/lib/profiles/fields"
import {
  checkboxSchema,
  formatSchema,
  intentSchema,
  optionalLine,
  optionalLongText,
  priceSchema,
  titleSchema,
  topicsSchema,
  type SupplyFieldErrors,
} from "@/lib/supply/fields"

/**
 * The product form (§5 products: title, description (Markdown), target user, stage, demo URL,
 * format, topics, preferred builder split, exclusivity, plus the target price of §19.5; §12
 * `/app/products/new`, `/app/products/[id]`). Client-safe.
 */

export const PRODUCT_DESCRIPTION_MAX = 5000
export const PRODUCT_TARGET_USER_MAX = 200
export const PRODUCT_DEMO_URL_MAX = 500

export const PRODUCT_STAGE_VALUES = [
  "idea",
  "prototype",
  "beta",
  "live",
] as const satisfies readonly ProductStage[]

export const PRODUCT_STAGE_LABELS: Record<ProductStage, { title: string; description: string }> = {
  idea: { title: "Idea", description: "Planned, not built yet." },
  prototype: { title: "Prototype", description: "Works, but rough." },
  beta: { title: "Beta", description: "People are trying it." },
  live: { title: "Live", description: "Finished and in use." },
}

const demoUrlSchema = z
  .string()
  .optional()
  .transform((value, context) => {
    const raw = (value ?? "").trim()
    if (raw === "") return null
    const url = normalizeWebUrl(raw)
    if (url === null) {
      context.addIssue({
        code: "custom",
        message: "Enter a web address, like https://example.com.",
      })
      return z.NEVER
    }
    return url
  })
  .pipe(z.string().max(PRODUCT_DEMO_URL_MAX, "That link is too long.").nullable())

/** "60", "60%" → 60; empty → null (no preference). Numbers pass through (tests). */
const splitPctSchema = z
  .union([z.string().max(10), z.number()])
  .optional()
  .transform((value, context) => {
    const message = "Enter a whole percentage from 0 to 100."
    if (value === undefined) return null
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        context.addIssue({ code: "custom", message })
        return z.NEVER
      }
      return value
    }
    const raw = value.trim().replace(/\s*%$/, "")
    if (raw === "") return null
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) {
      context.addIssue({ code: "custom", message })
      return z.NEVER
    }
    return Number(raw)
  })

export const productFieldsSchema = z.object({
  title: titleSchema("product"),
  description: optionalLongText(
    PRODUCT_DESCRIPTION_MAX,
    `Keep the description under ${PRODUCT_DESCRIPTION_MAX.toLocaleString("en-US")} characters.`,
  ),
  targetUser: optionalLine(
    PRODUCT_TARGET_USER_MAX,
    `Keep this under ${PRODUCT_TARGET_USER_MAX} characters.`,
  ),
  stage: z.enum(PRODUCT_STAGE_VALUES, { error: "Pick the stage it's at." }),
  demoUrl: demoUrlSchema,
  format: formatSchema,
  targetPrice: priceSchema,
  topics: topicsSchema,
  preferredSplitBuilderPct: splitPctSchema,
  exclusivity: checkboxSchema,
})
export type ProductFields = z.output<typeof productFieldsSchema>

export const productFormSchema = productFieldsSchema.extend({ intent: intentSchema })
export type ProductForm = z.output<typeof productFormSchema>

export const PRODUCT_FIELD_NAMES = [
  "title",
  "description",
  "targetUser",
  "stage",
  "demoUrl",
  "format",
  "targetPrice",
  "topics",
  "preferredSplitBuilderPct",
  "exclusivity",
] as const

/**
 * What a product needs before creators see it (decided in §19.25): a description (what it is
 * and does) and at least one topic (matching's `topic_overlap`). Empty when it can be published.
 */
export function productPublishProblems(
  fields: Pick<ProductFields, "description" | "topics">,
): SupplyFieldErrors {
  const problems: SupplyFieldErrors = {}
  if (!fields.description) problems.description = ["Describe the product before publishing."]
  if (fields.topics.length === 0) {
    problems.topics = ["Add at least one topic before publishing, so creators can find it."]
  }
  return problems
}

/** Column names (snake_case) of the editable fields, for `product.updated { fields }`. */
export const PRODUCT_COLUMNS: Record<keyof ProductFields, string> = {
  title: "title",
  description: "description",
  targetUser: "target_user",
  stage: "stage",
  demoUrl: "demo_url",
  format: "format",
  targetPrice: "target_price_cents",
  topics: "topics",
  preferredSplitBuilderPct: "preferred_split_builder_pct",
  exclusivity: "exclusivity",
}
