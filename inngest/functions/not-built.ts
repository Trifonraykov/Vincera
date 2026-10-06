/**
 * Placeholder handler for jobs whose owner has not built them yet (CLAUDE.md §19.38). The job is
 * registered so its id, event and schedule are part of the contract; running it does nothing.
 * Delete this file once nothing imports it.
 */
export function notBuiltYet(owner: string) {
  return async () => ({ skipped: true, reason: "not_implemented", owner }) as const
}
