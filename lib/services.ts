import path from "node:path"

/**
 * Shared plumbing for fake service implementations (§19.3).
 *
 * Whether a service is live or fake is decided by `isFake(service)` in `lib/env.ts`; this module
 * only holds what several fakes share. Fakes keep their state on disk under `.data/` (gitignored)
 * or in the database, never in module-level variables, so state survives across Next.js workers
 * and is visible to Playwright tests running in another process.
 *
 * Deliberately free of `server-only` and `lib/env` imports so test runners can use it too.
 */

/** Root directory for fake-service state. Resolved from the working directory on every call. */
export function dataDir(...segments: string[]): string {
  return path.join(process.cwd(), ".data", ...segments)
}
