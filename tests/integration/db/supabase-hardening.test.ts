import { Client } from "pg"
import { afterEach, describe, expect, it } from "vitest"

import { getPgError } from "@/lib/db/errors"
import {
  describeHardening,
  ensureVectorOnSearchPath,
  hardenSupabase,
  isFullyHardened,
  SUPABASE_API_ROLES,
} from "@/lib/db/supabase-hardening"

import { setupTestDatabase } from "../../helpers/db"
import { insertUser } from "../../helpers/db-fixtures"

/**
 * The post-migrate Supabase hardening (lib/db/supabase-hardening.ts, CLAUDE.md §19.21), run on
 * this file's clone of the migrated template. Supabase's roles are created inside a transaction
 * that is always rolled back, so the cluster (shared with other test files) is never changed.
 */

const testDb = setupTestDatabase()
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)))
})

/** One session (BEGIN … ROLLBACK need the same connection). */
async function connect(): Promise<Client> {
  const client = new Client({ connectionString: testDb.url })
  clients.push(client)
  await client.connect()
  return client
}

async function apiRolesExist(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_roles WHERE rolname = ANY($1::text[])",
    [[...SUPABASE_API_ROLES]],
  )
  return rows[0]?.count !== "0"
}

/**
 * What a fresh Supabase project has: the API roles, USAGE on public, default privileges that
 * grant them every table, sequence and function `postgres` creates in public, and PostgreSQL's
 * built-in EXECUTE for PUBLIC on new functions (restored here: the template may have been
 * hardened already, on a Supabase Postgres test server).
 */
const SUPABASE_PROJECT_SETUP = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_only_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.ledger_entries_guard() TO PUBLIC;
`

/** Tables in public and drizzle whose row-level security is off. */
async function tablesWithoutRls(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(`
    SELECT n.nspname || '.' || c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
    ORDER BY 1`)
  return rows.map((row) => row.name)
}

/** Every privilege the API roles hold on tables, views and sequences in public and drizzle. */
async function apiRoleRelationGrants(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ grant: string }>(`
    SELECT DISTINCT n.nspname || '.' || c.relname || ' ' || r.rolname || ' ' || a.privilege_type AS grant
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname IN ('public', 'drizzle') AND r.rolname IN ('anon', 'authenticated')
    ORDER BY 1`)
  return rows.map((row) => row.grant)
}

/** Whether `role` may execute `fn` (directly or through PUBLIC). */
async function canExecute(client: Client, role: string, fn: string): Promise<boolean> {
  const { rows } = await client.query<{ allowed: boolean }>(
    "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
    [role, fn],
  )
  return rows[0]?.allowed ?? false
}

const GUARDS = ["public.append_only_guard()", "public.ledger_entries_guard()"]

describe("hardenSupabase", () => {
  it("does nothing where Supabase's API roles do not exist (plain Postgres)", async (context) => {
    const client = await connect()
    if (await apiRolesExist(client)) context.skip() // a Supabase Postgres test server
    await client.query("BEGIN")
    try {
      await client.query("CREATE TABLE public.plain_probe (id int)")
      expect(await hardenSupabase(client)).toEqual({ applied: false, reason: "no_api_roles" })
      // Not even row-level security is touched.
      expect(await tablesWithoutRls(client)).toContain("public.plain_probe")
    } finally {
      await client.query("ROLLBACK")
    }
  })

  it("locks anon and authenticated out of every table, sequence and function, PUBLIC included", async () => {
    const user = await insertUser(testDb.db)
    const client = await connect()
    await client.query("BEGIN")
    try {
      await client.query(SUPABASE_PROJECT_SETUP)
      // A table a later migration creates without RLS (the default privileges grant it to the
      // API roles), a table whose RLS was switched off, and a grant on the migrations journal.
      await client.query("CREATE TABLE public.later_table (id serial PRIMARY KEY, secret text)")
      await client.query("ALTER TABLE public.users DISABLE ROW LEVEL SECURITY")
      await client.query("GRANT USAGE ON SCHEMA drizzle TO anon")
      await client.query("GRANT SELECT ON drizzle.__drizzle_migrations TO anon")
      expect(await tablesWithoutRls(client)).toEqual(
        expect.arrayContaining(["public.later_table", "public.users"]),
      )
      expect(await apiRoleRelationGrants(client)).toContain("public.users anon SELECT")
      // A grant to PUBLIC reaches the API roles too.
      await client.query("GRANT SELECT ON public.later_table TO PUBLIC")
      for (const fn of GUARDS)
        expect([fn, await canExecute(client, "anon", fn)]).toEqual([fn, true])

      const summary = await hardenSupabase(client)
      expect(summary.applied).toBe(true)
      if (!summary.applied) return
      expect(summary.roles).toEqual(["anon", "authenticated"])
      expect(summary.schemas).toEqual(["drizzle", "public"])
      expect(summary.rlsEnabled).toEqual(
        expect.arrayContaining(["public.later_table", "public.users"]),
      )
      expect(summary.revoked.relations).toBeGreaterThanOrEqual(43)
      expect(summary.revoked.sequences).toBeGreaterThanOrEqual(1)
      expect(summary.revoked.functions).toBeGreaterThanOrEqual(2) // the append-only guards
      expect(summary.revoked.schemas).toBe(1)
      // anon/authenticated in public for tables, sequences, functions; PUBLIC on new functions.
      expect(summary.defaultPrivileges).toBe(4)
      expect(summary.remaining).toEqual({ rlsOff: [], grants: [] })
      expect(isFullyHardened(summary)).toBe(true)
      expect(describeHardening(summary).join("\n")).toMatch(
        /directly or through PUBLIC, can read, change or call nothing/,
      )

      expect(await tablesWithoutRls(client)).toEqual([])
      expect(await apiRoleRelationGrants(client)).toEqual([])
      const functionGrants = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
        WHERE p.pronamespace = 'public'::regnamespace AND r.rolname IN ('anon', 'authenticated')
          AND p.proname IN ('append_only_guard', 'ledger_entries_guard')`)
      expect(functionGrants.rows[0]?.count).toBe("0")
      for (const role of ["anon", "authenticated"]) {
        for (const fn of GUARDS) {
          expect([role, fn, await canExecute(client, role, fn)]).toEqual([role, fn, false])
        }
      }
      const later = await client.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('anon', 'public.later_table', 'SELECT') AS allowed",
      )
      expect(later.rows[0]?.allowed).toBe(false)

      // A table created by a later migration is not granted to them either.
      await client.query("CREATE TABLE public.even_later (id int)")
      const probe = await client.query<{ anon: boolean; authenticated: boolean }>(`
        SELECT has_table_privilege('anon', 'public.even_later', 'SELECT') AS anon,
          has_table_privilege('authenticated', 'public.even_later', 'INSERT') AS authenticated`)
      expect(probe.rows[0]).toEqual({ anon: false, authenticated: false })
      // Nor is a function: no EXECUTE through PUBLIC, so PostgREST's /rpc cannot call it, even
      // one that reads tables as its owner (Supabase's usual pgvector `match_*` pattern).
      await client.query(`
        CREATE FUNCTION public.match_probe() RETURNS bigint
        LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.users'`)
      expect(await canExecute(client, "anon", "public.match_probe()")).toBe(false)
      expect(await canExecute(client, "authenticated", "public.match_probe()")).toBe(false)

      // Idempotent: a second run changes nothing.
      const again = await hardenSupabase(client)
      expect(again).toMatchObject({
        applied: true,
        rlsEnabled: ["public.even_later"],
        revoked: { relations: 0, sequences: 0, functions: 0, schemas: 0 },
        defaultPrivileges: 0,
        remaining: { rlsOff: [], grants: [] },
      })

      // The app's own role (the tables' owner) still reads and writes with RLS on.
      const own = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE id = $1",
        [user.id],
      )
      expect(own.rows[0]?.count).toBe("1")
      await client.query("UPDATE users SET name = 'Still works' WHERE id = $1", [user.id])

      // The Data API roles get nothing, even for a row that exists.
      for (const [role, statement] of [
        ["anon", "SELECT id FROM users"],
        ["authenticated", "UPDATE users SET name = 'x'"],
        ["anon", "SELECT * FROM drizzle.__drizzle_migrations"],
        ["authenticated", "INSERT INTO later_table (secret) VALUES ('x')"],
        ["anon", "SELECT public.match_probe()"],
      ] as const) {
        await client.query("SAVEPOINT api_role")
        await client.query(`SET LOCAL ROLE ${role}`)
        const error = await client.query(statement).then(
          () => null,
          (reason: unknown) => reason,
        )
        expect([role, statement, getPgError(error)?.code]).toEqual([role, statement, "42501"])
        await client.query("ROLLBACK TO SAVEPOINT api_role")
      }
    } finally {
      await client.query("ROLLBACK")
    }
  })

  it("hides rows from an API role through row-level security even if a grant comes back", async () => {
    const user = await insertUser(testDb.db)
    const client = await connect()
    await client.query("BEGIN")
    try {
      await client.query(SUPABASE_PROJECT_SETUP)
      await hardenSupabase(client)
      await client.query("GRANT SELECT ON users TO anon")
      await client.query("SET LOCAL ROLE anon")
      const visible = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE id = $1",
        [user.id],
      )
      expect(visible.rows[0]?.count).toBe("0")
    } finally {
      await client.query("ROLLBACK")
    }
  })
})

describe("ensureVectorOnSearchPath", () => {
  it("finds pgvector on the search_path after the migrations", async () => {
    const client = await connect()
    const result = await ensureVectorOnSearchPath(client)
    expect(result.status).toBe("ok")
  })

  it("adds the extension's schema to the role's search_path when it is elsewhere", async (context) => {
    const client = await connect()
    const owner = await client.query<{ movable: boolean }>(`
      SELECT pg_has_role(extowner, 'USAGE') AS movable FROM pg_extension WHERE extname = 'vector'`)
    // On Supabase's image the extension belongs to supabase_admin and cannot be moved.
    if (!owner.rows[0]?.movable) context.skip()
    await client.query("BEGIN")
    try {
      // Like a Supabase project whose pgvector was enabled in `extensions` from the dashboard,
      // seen from a role whose search_path lacks that schema.
      await client.query("CREATE SCHEMA vector_home")
      await client.query("ALTER EXTENSION vector SET SCHEMA vector_home")
      await client.query("SET search_path TO public")
      const missing = await client.query<{ resolves: boolean }>(
        "SELECT to_regtype('vector') IS NOT NULL AS resolves",
      )
      expect(missing.rows[0]?.resolves).toBe(false)

      const result = await ensureVectorOnSearchPath(client)
      expect(result).toMatchObject({ status: "fixed", schema: "vector_home" })
      if (result.status !== "fixed") return
      expect(result.searchPath).toBe('public, "vector_home"')

      // The type and its operators resolve, and the setting is stored for the role in this
      // database, so new sessions (the app, the migrations) get it too.
      const distance = await client.query<{ d: number }>(
        "SELECT ('[1,0]'::vector <=> '[0,1]'::vector) AS d",
      )
      expect(distance.rows[0]?.d).toBe(1)
      const stored = await client.query<{ config: string[] }>(`
        SELECT s.setconfig AS config FROM pg_db_role_setting s
        WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      expect(stored.rows[0]?.config).toEqual([
        expect.stringMatching(/^search_path=public, "?vector_home"?$/),
      ])
    } finally {
      await client.query("ROLLBACK")
    }
  })

  it("reports a database without pgvector as absent", async () => {
    const client = await connect()
    await client.query("BEGIN")
    try {
      await client.query("DROP EXTENSION vector CASCADE")
      expect(await ensureVectorOnSearchPath(client)).toEqual({ status: "absent" })
    } catch (error) {
      // Supabase's image: only the extension's owner may drop it.
      if (getPgError(error)?.code !== "42501") throw error
    } finally {
      await client.query("ROLLBACK")
    }
  })
})
