import "server-only"

import type Stripe from "stripe"
import type { z } from "zod"

import type { Tx } from "@/lib/db/client"
import type { JsonObject } from "@/lib/db/schema"

import type { StripeEvent } from "../schemas"

/**
 * Building blocks for Stripe webhook handlers (§7.2, §19.12). Each topic has a file next to this
 * one (`account.ts`, later `checkout.ts`, `charges.ts`, `refunds.ts`, `disputes.ts`,
 * `transfers.ts`, ...) exporting a `StripeHandlerGroup`, and `./index.ts` registers the groups.
 */

export type StripeWebhookContext = {
  /** The transaction that also marks the event processed; write everything with it. */
  tx: Tx
  /** When processing started (`lib/clock`). */
  now: Date
}

/** A verified event whose `data.object` was parsed with the handler's schema. */
export type ParsedStripeEvent<T> = Omit<StripeEvent, "data"> & {
  data: { object: T; previous_attributes?: JsonObject | null }
}

/** A registered handler: takes the verified event with `data.object` still unparsed. */
export type StripeEventHandler = (
  event: StripeEvent,
  context: StripeWebhookContext,
) => Promise<void>

/** One topic's handlers, keyed by Stripe's event type (typos fail typecheck). */
export type StripeHandlerGroup = Partial<Record<Stripe.Event.Type, StripeEventHandler>>

/**
 * Pair a handler with the Zod schema of its event's `data.object` (§4: every external payload is
 * parsed). A payload that does not parse throws, so the event fails (500) and stays unprocessed.
 */
export function on<Schema extends z.ZodType>(
  schema: Schema,
  handler: (
    event: ParsedStripeEvent<z.output<Schema>>,
    context: StripeWebhookContext,
  ) => Promise<void>,
): StripeEventHandler {
  // Async, so a payload that does not parse rejects like a failing handler.
  return async (event, context) =>
    handler({ ...event, data: { ...event.data, object: schema.parse(event.data.object) } }, context)
}

/** The time an event's data was current (`created`, whole seconds). */
export function eventTime(event: Pick<StripeEvent, "created">): Date {
  return new Date(event.created * 1000)
}

/**
 * Merge topic groups into one lookup table. Two groups handling the same type is a programming
 * error (one would silently win), so it throws when the module loads.
 */
export function registerStripeHandlers(
  groups: readonly StripeHandlerGroup[],
): ReadonlyMap<string, StripeEventHandler> {
  const table = new Map<string, StripeEventHandler>()
  for (const group of groups) {
    for (const [type, handler] of Object.entries(group)) {
      if (!handler) continue
      if (table.has(type)) {
        throw new Error(`Stripe webhook handler for "${type}" is registered twice`)
      }
      table.set(type, handler)
    }
  }
  return table
}
