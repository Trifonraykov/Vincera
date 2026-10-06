import "server-only"

import { after } from "next/server"

import { reportError } from "@/lib/observability"

/**
 * Work that should not hold up the response (an audience summary after a manual entry, a
 * best-effort token revocation after a disconnect, re-embedding a profile after an edit). Inside a
 * request it runs right after the response is sent (`after()`); outside one (scripts, tests) it
 * runs before this resolves. Errors are reported with `area` and `label` tags, never thrown at the
 * caller, like a background job (lib/jobs/enqueue.ts).
 */
export async function runInBackground(
  area: string,
  label: string,
  task: () => Promise<unknown>,
): Promise<void> {
  const guarded = async () => {
    try {
      await task()
    } catch (error) {
      reportError(error, { tags: { area, background: label } })
    }
  }
  try {
    after(guarded)
  } catch {
    // `after` throws outside a request scope.
    await guarded()
  }
}
