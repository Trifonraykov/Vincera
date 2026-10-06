import type { Db } from "@/lib/db/client"

/**
 * `pnpm db:seed` (§15): demo data for local runs, Docker and e2e. Steps run in order, each in its
 * own file owned by one area (CLAUDE.md §19.24 "Seed"):
 *
 *   people   matching  10 creators (verified YouTube fixture connections) and 10 builders
 *   supply   matching  ideas and products in every status
 *   matches  matching  a `matching/recompute` per seeded user (real code path)
 *   collabs  collab    3 collabs in different stages (agreement, building, and one signed)
 *   launches launch    collab 03's launch taken live (default tracked link)
 *   orders   checkout  paid orders of that launch with their ledger (CLAUDE.md §19.31)
 *
 * Rules: idempotent (Docker runs the seed on every start; look rows up by their fixed emails
 * `seed-creator-01@example.com` … `seed-creator-10@example.com` and `seed-builder-01@example.com`
 * … `-10`, and skip what exists); write through the same domain functions the app uses where
 * they exist, so events and constraints hold; times from `ctx.now`; never in production.
 */
export type SeedContext = {
  db: Db
  now: Date
  log: (line: string) => void
}

export type SeedStep = {
  name: string
  /** The area that implements it. */
  owner: string
  run: (ctx: SeedContext) => Promise<{ created: number } | { skipped: string }>
}
