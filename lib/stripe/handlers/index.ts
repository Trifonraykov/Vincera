import "server-only"

import { accountHandlers } from "./account"
import { registerStripeHandlers, type StripeEventHandler, type StripeHandlerGroup } from "./define"

export {
  eventTime,
  on,
  type ParsedStripeEvent,
  type StripeEventHandler,
  type StripeHandlerGroup,
  type StripeWebhookContext,
} from "./define"

/**
 * Every Stripe webhook handler, by topic (§7.2, §19.12). To handle a new event type: add a Zod
 * schema for its `data.object` to `../schemas.ts`, put the handler in this folder's topic file
 * (or a new `<topic>.ts` exporting a `StripeHandlerGroup`), and register a new group here with
 * one line. Event types without a handler are acknowledged and marked processed.
 */
const HANDLER_GROUPS: readonly StripeHandlerGroup[] = [
  accountHandlers, // account.updated, capability.updated (Phase 1)
]

const HANDLERS = registerStripeHandlers(HANDLER_GROUPS)

/** The handler for an event type, or null when the platform does not act on it. */
export function stripeEventHandler(type: string): StripeEventHandler | null {
  return HANDLERS.get(type) ?? null
}

/** The event types with a handler (the events to enable on the Stripe endpoints). */
export function handledStripeEventTypes(): string[] {
  return [...HANDLERS.keys()].sort()
}
