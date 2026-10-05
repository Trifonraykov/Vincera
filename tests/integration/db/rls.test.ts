import { readFileSync } from "node:fs"
import path from "node:path"

import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import type { Tx } from "@/lib/db/client"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"

/**
 * Supabase's Data API (PostgREST) serves the `public` schema to the `anon` and `authenticated`
 * roles. The platform never uses it, so every table has row-level security on with no policies
 * (`withRLS`, migration 0007) and those roles lose their grants (0008). The app connects as the
 * tables' owner, which RLS does not restrict.
 */

const testDb = setupTestDatabase()

const GRANTS_MIGRATION = readFileSync(
  path.join(process.cwd(), "drizzle", "0008_supabase_data_api_grants.sql"),
  "utf8",
)

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back (roles and grants included). */
async function inRolledBackTransaction(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(
    testDb.db.transaction(async (tx) => {
      await fn(tx)
      throw new Rollback()
    }),
  ).rejects.toBeInstanceOf(Rollback)
}

/** Supabase's API roles, as a fresh Supabase project has them (created in the transaction). */
async function createSupabaseApiRoles(tx: Tx): Promise<void> {
  await tx.execute(
    sql.raw(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$`),
  )
  await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO anon, authenticated`))
}

async function publicTables(tx: Tx | typeof testDb.db) {
  const result = await tx.execute<{ name: string; rls: boolean; forced: boolean }>(sql`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`)
  return result.rows
}

describe("row-level security (Supabase Data API lockdown)", () => {
  it("is on for every table in public, and not forced (the owning app role is unaffected)", async () => {
    const tables = await publicTables(testDb.db)
    expect(tables.length).toBeGreaterThanOrEqual(42)
    expect(tables.filter((table) => !table.rls).map((table) => table.name)).toEqual([])
    expect(tables.filter((table) => table.forced).map((table) => table.name)).toEqual([])
  })

  it("hides every row from an API role even when it holds a grant", async () => {
    const user = await insertUser(testDb.db)
    await inRolledBackTransaction(async (tx) => {
      await createSupabaseApiRoles(tx)
      await tx.execute(sql.raw(`GRANT SELECT ON users TO anon`))
      await tx.execute(sql.raw(`SET LOCAL ROLE anon`))
      const visible = await tx.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM users WHERE id = ${user.id}`,
      )
      expect(visible.rows[0]?.count).toBe("0")
    })
    // The app's own role still sees the row.
    const own = await testDb.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM users WHERE id = ${user.id}`,
    )
    expect(own.rows[0]?.count).toBe("1")
  })

  it("migration 0008 revokes the API roles' grants and default privileges", async () => {
    await inRolledBackTransaction(async (tx) => {
      await createSupabaseApiRoles(tx)
      // What a Supabase project's default privileges hand out to every new table.
      await tx.execute(
        sql.raw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;`),
      )

      await tx.execute(sql.raw(GRANTS_MIGRATION))

      const granted = await tx.execute<{ name: string; role: string }>(sql`
        SELECT c.relname AS name, r.rolname AS role
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_roles r
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND r.rolname IN ('anon', 'authenticated')
          AND (has_table_privilege(r.oid, c.oid, 'SELECT')
            OR has_table_privilege(r.oid, c.oid, 'INSERT')
            OR has_table_privilege(r.oid, c.oid, 'UPDATE')
            OR has_table_privilege(r.oid, c.oid, 'DELETE'))`)
      expect(granted.rows).toEqual([])

      // A table created by a later migration gets no grants either.
      await tx.execute(sql.raw(`CREATE TABLE rls_probe (id int)`))
      const probe = await tx.execute<{ allowed: boolean }>(
        sql`SELECT has_table_privilege('anon', 'rls_probe', 'SELECT') AS allowed`,
      )
      expect(probe.rows[0]?.allowed).toBe(false)
    })
  })

  it("migration 0008 does nothing where the Supabase roles do not exist", async () => {
    const roles = await testDb.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
    )
    // Plain Postgres (CI, local): the migration already ran here without error.
    if (roles.rows[0]?.count === "0") {
      await expect(testDb.db.execute(sql.raw(GRANTS_MIGRATION))).resolves.toBeDefined()
    }
  })
})
