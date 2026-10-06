import { z } from "zod"

/**
 * Small building blocks for the Stripe object schemas (`./schemas.ts` and the Phase 4–5 topic files
 * `./checkout-shared.ts`, `./money-shared.ts`, `./promotions-shared.ts`). A module of its own so the
 * topic files and `./schemas.ts` (which re-exports them) never import each other.
 */

/**
 * A Stripe object id with its prefix, e.g. `stripeIdSchema("cs")` for `cs_test_…` / `cs_fake_…`
 * (the fake uses the same prefixes as Stripe).
 */
export function stripeIdSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`))
}

/**
 * A field Stripe returns as an id, or as the object when `expand`ed. Only the id is read here; use
 * a dedicated schema where the expanded object matters (e.g. `latest_charge`).
 */
export function expandableIdSchema(prefix: string) {
  const id = stripeIdSchema(prefix)
  return z.union([id, z.object({ id })])
}

/** The id of an expandable field (`"ch_1"` or `{ id: "ch_1", … }`), or null when absent. */
export function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" ? value : value.id
}

/** Stripe metadata: string values only. */
export const stripeMetadataSchema = z.record(z.string(), z.string())
