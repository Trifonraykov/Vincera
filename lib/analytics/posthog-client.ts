import type { BeforeSendFn } from "posthog-js"

import { redactDeep } from "./redact"

/**
 * PostHog's `before_send` (instrumentation-client.ts): every event's properties (`$current_url`,
 * `$pathname`, `$referrer`, `$initial_current_url`, autocapture's `$elements_chain` with link
 * `href`s, ...) and person properties go through `redactDeep`, so a buyer's `/access/<token>` and
 * the success page's `session_id` never reach PostHog (§11, §14; CLAUDE.md §19.37).
 */
export const redactPostHogEvent: BeforeSendFn = (event) => {
  if (!event) return event
  redactDeep(event.properties)
  if (event.$set) redactDeep(event.$set)
  if (event.$set_once) redactDeep(event.$set_once)
  return event
}
