import { describe, expect, it } from "vitest"

import {
  describeHardening,
  isFullyHardened,
  type HardeningSummary,
} from "@/lib/db/supabase-hardening"

const hardened: HardeningSummary = {
  applied: true,
  roles: ["anon", "authenticated"],
  schemas: ["drizzle", "public"],
  tables: 43,
  rlsEnabled: ["drizzle.__drizzle_migrations"],
  revoked: { relations: 0, sequences: 0, functions: 2, schemas: 0 },
  defaultPrivileges: 1,
  extensionFunctions: 118,
  remaining: { rlsOff: [], grants: [] },
}

describe("describeHardening", () => {
  it("says nothing happened on plain Postgres", () => {
    const skipped: HardeningSummary = { applied: false, reason: "no_api_roles" }
    expect(describeHardening(skipped)).toEqual([
      "Supabase hardening: skipped (no anon/authenticated roles, so no Supabase Data API here).",
    ])
    expect(isFullyHardened(skipped)).toBe(true)
  })

  it("summarises a hardened database", () => {
    expect(describeHardening(hardened)).toEqual([
      "Supabase hardening (roles anon, authenticated; schemas drizzle, public):",
      "  row-level security on for 43 of 43 tables (switched on now: drizzle.__drizzle_migrations)",
      "  API-role grants revoked now: 0 tables/views, 0 sequences, 2 functions, 0 schemas; default privileges cleared: 1",
      "  left alone: 118 extension functions (e.g. pgvector's math functions; they read no table)",
      "  the Data API roles, directly or through PUBLIC, can read, change or call nothing but those extension functions in these schemas.",
    ])
    expect(isFullyHardened(hardened)).toBe(true)
    expect(describeHardening({ ...hardened, extensionFunctions: 0 }).at(-1)).toBe(
      "  the Data API roles, directly or through PUBLIC, can read, change or call nothing in these schemas.",
    )
  })

  it("counts a function PUBLIC can still execute as not hardened", () => {
    const publicLeft: HardeningSummary = {
      ...hardened,
      remaining: { rlsOff: [], grants: ["public.match_docs(vector) (PUBLIC)"] },
    }
    expect(isFullyHardened(publicLeft)).toBe(false)
    expect(describeHardening(publicLeft).at(-1)).toMatch(
      /WARNING: .*public\.match_docs\(vector\) \(PUBLIC\)/,
    )
  })

  it("warns about what another role owns", () => {
    const partial: HardeningSummary = {
      ...hardened,
      extensionFunctions: 0,
      remaining: { rlsOff: ["public.spatial_ref_sys"], grants: ["public.spatial_ref_sys (anon)"] },
    }
    const lines = describeHardening(partial)
    expect(lines.at(-1)).toBe(
      "  WARNING: could not fix objects owned or granted by another role: public.spatial_ref_sys (row-level security off), public.spatial_ref_sys (anon)",
    )
    expect(lines[1]).toBe(
      "  row-level security on for 42 of 43 tables (switched on now: drizzle.__drizzle_migrations)",
    )
    expect(isFullyHardened(partial)).toBe(false)
  })
})
