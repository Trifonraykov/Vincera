import type { QueryResultRow } from "pg"

/**
 * Supabase hardening, run by `pnpm db:migrate` after the migrations (scripts/lib/db-admin.ts;
 * CLAUDE.md §19.21). Pure SQL over a client the caller owns; no `server-only`, no lib/env, so the
 * scripts and the test tooling can use it.
 *
 * **Why.** Supabase serves the `public` schema through its Data API (PostgREST) to the `anon` and
 * `authenticated` roles, whose key ships in every Supabase client app, and the project's default
 * privileges grant those roles every table, sequence and function `postgres` creates there. Tables
 * created by SQL have row-level security off. Without this step anyone holding the project's
 * public anon key could read and write every table: users, sessions, encrypted tokens, the
 * ledger. The platform never uses the Data API: the app connects as the tables' owner, which RLS
 * does not restrict (RLS is enabled, not forced; on Supabase `postgres` also has BYPASSRLS).
 *
 * **What**, only when at least one of those roles exists (on plain Postgres this is a no-op), in
 * the caller's transaction, idempotently:
 * 1. Row-level security on for every table in `public` and `drizzle` (the migrations' journal),
 *    with no policies, so the API roles see no rows even if a grant comes back.
 * 2. Revoke every grant those roles hold on tables, views, sequences and functions in those
 *    schemas (and USAGE on `drizzle`), where the grant is ours to revoke, **including grants to
 *    PUBLIC**, which every role (the API roles too) inherits. PostgreSQL gives PUBLIC EXECUTE on
 *    every new function, and PostgREST serves every function the anon role can execute at
 *    `/rest/v1/rpc/<name>`. Revoking it is safe for trigger functions: EXECUTE on them is only
 *    checked when a trigger is created, by their owner.
 * 3. Revoke the migrating role's default privileges for them and for PUBLIC (in those schemas,
 *    and global, including PostgreSQL's built-in EXECUTE for PUBLIC on new functions), so objects
 *    created by later migrations are not granted to them either.
 *
 * Left alone, and reported: objects owned or granted by other roles (we cannot change them).
 * Extension functions (on Supabase, pgvector's math functions, installed by `supabase_admin`,
 * executable by PUBLIC) only compute on their arguments and read no table, so they are counted,
 * not reported as problems.
 *
 * It changes every object in those schemas, so it must only run on the platform's own database:
 * `runMigrations` refuses a database holding objects the platform did not create
 * (`foreignObjects`) unless told otherwise.
 */

export const SUPABASE_API_ROLES = ["anon", "authenticated"] as const
export const HARDENED_SCHEMAS = ["public", "drizzle"] as const

/** The pseudo-role every role belongs to (grantee oid 0 in an ACL). */
const PUBLIC_GRANTEE = "PUBLIC"

/** Anything that runs SQL: a `pg` Client, PoolClient or Pool. */
export type SqlClient = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

export type HardeningSummary =
  | { applied: false; reason: "no_api_roles" }
  | {
      applied: true
      roles: string[]
      schemas: string[]
      /** Tables in those schemas. */
      tables: number
      /** Tables whose row-level security this run switched on (`schema.table`). */
      rlsEnabled: string[]
      /** Objects this run revoked API-role grants on. */
      revoked: { relations: number; sequences: number; functions: number; schemas: number }
      /**
       * Default-privilege entries of the migrating role this run cleared (counting PostgreSQL's
       * built-in EXECUTE for PUBLIC on new functions as one).
       */
      defaultPrivileges: number
      /** Extension functions the API roles can execute, directly or through PUBLIC (left alone). */
      extensionFunctions: number
      /** What could not be fixed (owned or granted by another role); empty when hardened. */
      remaining: { rlsOff: string[]; grants: string[] }
    }

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Grantees for GRANT/REVOKE: role names quoted, PUBLIC as the keyword. */
function roleList(roles: readonly string[]): string {
  return roles.map((role) => (role === PUBLIC_GRANTEE ? "PUBLIC" : ident(role))).join(", ")
}

type RelationGrant = {
  schema: string
  name: string
  kind: string
  role: string
  ours: boolean
}

type FunctionGrant = {
  schema: string
  name: string
  args: string
  role: string
  ours: boolean
  extension: boolean
}

const TABLES_WITHOUT_RLS = `
  SELECT n.nspname AS schema, c.relname AS name, pg_has_role(c.relowner, 'USAGE') AS owned
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  ORDER BY 1, 2`

/**
 * An ACL's grantee as a name: the API roles by name, PUBLIC (oid 0) as `PUBLIC`. The WHERE
 * clause keeps the API roles and PUBLIC only.
 */
const GRANTEE = `CASE WHEN a.grantee = 0 THEN '${PUBLIC_GRANTEE}' ELSE r.rolname::text END`
const GRANTEE_IN_SCOPE = `(a.grantee = 0 OR r.rolname = ANY($2::text[]))`

/**
 * Grants to the API roles or PUBLIC on tables, partitioned tables, views, materialized and foreign
 * tables, sequences. (A NULL `relacl` means the owner's default, which grants nobody else.)
 */
const RELATION_GRANTS = `
  SELECT DISTINCT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
    ${GRANTEE} AS role, pg_has_role(a.grantor, 'USAGE') AS ours
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = ANY($1::text[]) AND ${GRANTEE_IN_SCOPE}
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ORDER BY 1, 2, 4`

/**
 * EXECUTE for the API roles or PUBLIC on functions and procedures. A NULL `proacl` means
 * PostgreSQL's default for functions, which includes EXECUTE for PUBLIC (`acldefault`).
 */
const FUNCTION_GRANTS = `
  SELECT DISTINCT n.nspname AS schema, p.proname AS name,
    pg_get_function_identity_arguments(p.oid) AS args, ${GRANTEE} AS role,
    pg_has_role(a.grantor, 'USAGE') AS ours,
    EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    ) AS extension
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = ANY($1::text[]) AND ${GRANTEE_IN_SCOPE}
  ORDER BY 1, 2, 3, 4`

/**
 * USAGE/CREATE on the hardened schemas other than `public` (Supabase needs `public` usage, and
 * PostgreSQL gives PUBLIC usage on it; no object in it is granted to them).
 */
const SCHEMA_GRANTS = `
  SELECT DISTINCT n.nspname AS schema, ${GRANTEE} AS role, pg_has_role(a.grantor, 'USAGE') AS ours
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(n.nspacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = ANY($1::text[]) AND n.nspname <> 'public' AND ${GRANTEE_IN_SCOPE}
  ORDER BY 1, 2`

/**
 * The migrating role's default-privilege entries that hand new objects to the API roles, or new
 * tables, sequences and functions to PUBLIC (PUBLIC's USAGE on types and schemas exposes no data).
 */
const DEFAULT_PRIVILEGES = `
  SELECT COALESCE(n.nspname, '') AS schema, d.defaclobjtype::text AS type,
    array_agg(DISTINCT ${GRANTEE} ORDER BY ${GRANTEE}) AS grantees
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND (r.rolname = ANY($2::text[]) OR (a.grantee = 0 AND d.defaclobjtype IN ('r', 'S', 'f')))
    AND (d.defaclnamespace = 0 OR n.nspname = ANY($1::text[]))
  GROUP BY 1, 2
  ORDER BY 1, 2`

/**
 * Whether new functions of the migrating role still get EXECUTE for PUBLIC: PostgreSQL's built-in
 * default when the role has no global default-privilege entry for functions, else that entry.
 * (Per-schema entries can only add to the global one, so this is revoked globally.)
 */
const PUBLIC_EXECUTE_BY_DEFAULT = `
  SELECT CASE WHEN d.oid IS NULL THEN true
    ELSE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0) END AS granted
  FROM (SELECT 1) AS one
  LEFT JOIN pg_default_acl d
    ON d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'`

const DEFAULT_PRIVILEGE_OBJECTS: Record<string, string> = {
  r: "TABLES",
  S: "SEQUENCES",
  f: "FUNCTIONS",
  T: "TYPES",
  n: "SCHEMAS",
}

/**
 * Lock the Supabase Data API roles out of the platform's schemas. Run it inside a transaction
 * (`runSupabaseHardening` does). Idempotent: a second run changes nothing and reports zeros.
 */
export async function hardenSupabase(client: SqlClient): Promise<HardeningSummary> {
  const { rows: roleRows } = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
    [[...SUPABASE_API_ROLES]],
  )
  const roles = roleRows.map((row) => row.rolname)
  if (roles.length === 0) return { applied: false, reason: "no_api_roles" }

  const { rows: schemaRows } = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname",
    [[...HARDENED_SCHEMAS]],
  )
  const schemas = schemaRows.map((row) => row.nspname)
  const scope = [schemas, roles]

  // 1. Row-level security on every table we own.
  const rlsEnabled: string[] = []
  const { rows: withoutRls } = await client.query<{ schema: string; name: string; owned: boolean }>(
    TABLES_WITHOUT_RLS,
    [schemas],
  )
  for (const table of withoutRls.filter((row) => row.owned)) {
    await client.query(
      `ALTER TABLE ${ident(table.schema)}.${ident(table.name)} ENABLE ROW LEVEL SECURITY`,
    )
    rlsEnabled.push(`${table.schema}.${table.name}`)
  }

  // 2. Grants on relations, functions and schemas.
  const revoked = { relations: 0, sequences: 0, functions: 0, schemas: 0 }
  const relationGrants = (await client.query<RelationGrant>(RELATION_GRANTS, scope)).rows
  const ownRelationGrants = relationGrants.filter((g) => g.ours)
  for (const [, grants] of groupBy(ownRelationGrants, (g) => `${g.schema}.${g.name}`)) {
    const first = grants[0]
    if (!first) continue
    const objectType = first.kind === "S" ? "SEQUENCE" : "TABLE"
    await client.query(
      `REVOKE ALL ON ${objectType} ${ident(first.schema)}.${ident(first.name)} FROM ${roleList(unique(grants.map((g) => g.role)))}`,
    )
    if (first.kind === "S") revoked.sequences++
    else revoked.relations++
  }

  const functionGrants = (await client.query<FunctionGrant>(FUNCTION_GRANTS, scope)).rows
  const functionKey = (g: FunctionGrant) => `${g.schema}.${g.name}(${g.args})`
  // PUBLIC keeps EXECUTE on extension functions (they compute on their arguments only).
  const leftAlone = (g: FunctionGrant) => g.extension && (!g.ours || g.role === PUBLIC_GRANTEE)
  for (const [, grants] of groupBy(
    functionGrants.filter((g) => g.ours && !leftAlone(g)),
    functionKey,
  )) {
    const first = grants[0]
    if (!first) continue
    await client.query(
      `REVOKE ALL ON ROUTINE ${ident(first.schema)}.${ident(first.name)}(${first.args}) FROM ${roleList(unique(grants.map((g) => g.role)))}`,
    )
    revoked.functions++
  }
  const extensionFunctions = new Set(functionGrants.filter(leftAlone).map(functionKey)).size

  const schemaGrants = (
    await client.query<{ schema: string; role: string; ours: boolean }>(SCHEMA_GRANTS, scope)
  ).rows
  for (const [schema, grants] of groupBy(
    schemaGrants.filter((g) => g.ours),
    (g) => g.schema,
  )) {
    await client.query(
      `REVOKE ALL ON SCHEMA ${ident(schema)} FROM ${roleList(unique(grants.map((g) => g.role)))}`,
    )
    revoked.schemas++
  }

  // 3. Default privileges of the migrating role.
  const defaults = (
    await client.query<{ schema: string; type: string; grantees: string[] }>(
      DEFAULT_PRIVILEGES,
      scope,
    )
  ).rows
  let defaultPrivileges = 0
  for (const entry of defaults) {
    const objects = DEFAULT_PRIVILEGE_OBJECTS[entry.type]
    if (!objects) continue
    const inSchema = entry.schema ? ` IN SCHEMA ${ident(entry.schema)}` : ""
    await client.query(
      `ALTER DEFAULT PRIVILEGES${inSchema} REVOKE ALL ON ${objects} FROM ${roleList(entry.grantees)}`,
    )
    defaultPrivileges++
  }
  // PostgreSQL's built-in EXECUTE for PUBLIC on every new function (no catalog entry until now).
  if (await publicExecuteByDefault(client)) {
    await client.query("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
    defaultPrivileges++
  }

  // What is left: things owned or granted by other roles.
  const rlsOff = (
    await client.query<{ schema: string; name: string }>(TABLES_WITHOUT_RLS, [schemas])
  ).rows.map((row) => `${row.schema}.${row.name}`)
  const grantsLeft = [
    ...(await client.query<RelationGrant>(RELATION_GRANTS, scope)).rows.map(
      (g) => `${g.schema}.${g.name} (${g.role})`,
    ),
    ...(await client.query<FunctionGrant>(FUNCTION_GRANTS, scope)).rows
      .filter((g) => !g.extension)
      .map((g) => `${functionKey(g)} (${g.role})`),
    ...(await client.query<{ schema: string; role: string }>(SCHEMA_GRANTS, scope)).rows.map(
      (g) => `schema ${g.schema} (${g.role})`,
    ),
    ...((await publicExecuteByDefault(client)) ? ["new functions (EXECUTE for PUBLIC)"] : []),
  ]

  return {
    applied: true,
    roles,
    schemas,
    tables: await countTables(client, schemas),
    rlsEnabled,
    revoked,
    defaultPrivileges,
    extensionFunctions,
    remaining: { rlsOff, grants: grantsLeft },
  }
}

async function publicExecuteByDefault(client: SqlClient): Promise<boolean> {
  const { rows } = await client.query<{ granted: boolean }>(PUBLIC_EXECUTE_BY_DEFAULT)
  return rows[0]?.granted ?? true
}

async function countTables(client: SqlClient, schemas: string[]): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')`,
    [schemas],
  )
  return Number(rows[0]?.count ?? 0)
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    groups.set(k, [...(groups.get(k) ?? []), item])
  }
  return groups
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Run `hardenSupabase` in its own transaction on a client checked out of `pool`. */
export async function runSupabaseHardening(pool: {
  connect(): Promise<SqlClient & { release(): void }>
}): Promise<HardeningSummary> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const summary = await hardenSupabase(client)
    await client.query("COMMIT")
    return summary
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Log lines for `pnpm db:migrate`. */
export function describeHardening(summary: HardeningSummary): string[] {
  if (!summary.applied) {
    return [
      "Supabase hardening: skipped (no anon/authenticated roles, so no Supabase Data API here).",
    ]
  }
  const { revoked } = summary
  const lines = [
    `Supabase hardening (roles ${summary.roles.join(", ")}; schemas ${summary.schemas.join(", ")}):`,
    `  row-level security on for ${summary.tables - summary.remaining.rlsOff.length} of ${summary.tables} tables` +
      (summary.rlsEnabled.length > 0 ? ` (switched on now: ${summary.rlsEnabled.join(", ")})` : ""),
    `  API-role grants revoked now: ${revoked.relations} tables/views, ${revoked.sequences} sequences, ` +
      `${revoked.functions} functions, ${revoked.schemas} schemas; default privileges cleared: ${summary.defaultPrivileges}`,
  ]
  if (summary.extensionFunctions > 0) {
    lines.push(
      `  left alone: ${summary.extensionFunctions} extension functions (e.g. pgvector's math functions; they read no table)`,
    )
  }
  if (summary.remaining.rlsOff.length > 0 || summary.remaining.grants.length > 0) {
    lines.push(
      `  WARNING: could not fix objects owned or granted by another role: ${[
        ...summary.remaining.rlsOff.map((table) => `${table} (row-level security off)`),
        ...summary.remaining.grants,
      ].join(", ")}`,
    )
  } else {
    const but = summary.extensionFunctions > 0 ? " but those extension functions" : ""
    lines.push(
      `  the Data API roles, directly or through PUBLIC, can read, change or call nothing${but} in these schemas.`,
    )
  }
  return lines
}

/** Whether a hardening run left everything locked down. */
export function isFullyHardened(summary: HardeningSummary): boolean {
  return (
    !summary.applied ||
    (summary.remaining.rlsOff.length === 0 && summary.remaining.grants.length === 0)
  )
}

/** What `foreignObjects` found. */
export type DatabaseOwnership = {
  /** The migrations' journal records at least one of this platform's migrations. */
  platform: boolean
  /** Objects the platform did not create (empty when `platform`). */
  objects: string[]
}

/** drizzle's migrations journal (drizzle-orm's default schema and table). */
const JOURNAL = "drizzle.__drizzle_migrations"

/**
 * Tables, views, sequences and routines in `public` that belong to no extension. Sequences owned
 * by a column (serial, identity) are listed with their table.
 */
const PUBLIC_OBJECTS = `
  SELECT format('%I.%I', n.nspname, c.relname) AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i')
    )
  UNION ALL
  SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    )
  ORDER BY 1`

/**
 * Whether a database is the platform's to migrate and harden. It is when drizzle's journal
 * records one of `migrationHashes` (the platform's migrations, as drizzle hashes them). Otherwise
 * every table, view, sequence and routine in `public` outside extensions is someone else's, and
 * so are journal entries of another Drizzle app: the migrations and `hardenSupabase` would change
 * them (row-level security on, Data API grants revoked), breaking the app that uses them. An
 * empty database (a fresh Supabase project) has none. Read-only.
 */
export async function foreignObjects(
  client: SqlClient,
  migrationHashes: readonly string[],
): Promise<DatabaseOwnership> {
  const journal = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [JOURNAL],
  )
  const objects: string[] = []
  if (journal.rows[0]?.exists) {
    const { rows } = await client.query<{ ours: boolean; entries: string }>(
      `SELECT coalesce(bool_or(hash = ANY($1::text[])), false) AS ours, count(*)::text AS entries
       FROM ${JOURNAL}`,
      [[...migrationHashes]],
    )
    if (rows[0]?.ours) return { platform: true, objects: [] }
    const entries = Number(rows[0]?.entries ?? 0)
    if (entries > 0) {
      objects.push(`${JOURNAL} (${entries} migration${entries === 1 ? "" : "s"} of another app)`)
    }
  }
  const { rows } = await client.query<{ name: string }>(PUBLIC_OBJECTS)
  objects.push(...rows.map((row) => row.name))
  return { platform: false, objects }
}

export type VectorSearchPath =
  /** pgvector is not installed yet (migration 0000 installs it). */
  | { status: "absent" }
  /** The `vector` type resolves with the role's search_path. */
  | { status: "ok"; schema: string }
  /** It did not; the role's search_path in this database now includes the extension's schema. */
  | { status: "fixed"; schema: string; role: string; database: string; searchPath: string }

/**
 * Make sure the `vector` type (and pgvector's operators) resolve for the migrating role, whatever
 * schema the extension lives in. A Supabase project may already have pgvector in `extensions`
 * (the dashboard's default); migrations, drizzle's queries and the app use the unqualified
 * `vector(1024)` / `<=>`. When the extension's schema is not on the role's search_path, it is
 * appended for this role in this database (`ALTER ROLE … IN DATABASE … SET search_path`, which
 * a non-superuser may do for itself), so new sessions of the app and the migrations resolve it.
 * Run it on its own connection before migrating; the migration's connection must be opened after.
 */
export async function ensureVectorOnSearchPath(client: SqlClient): Promise<VectorSearchPath> {
  const { rows } = await client.query<{
    schema: string
    resolves: boolean
    search_path: string
    role: string
    database: string
  }>(`
    SELECT n.nspname AS schema, to_regtype('vector') IS NOT NULL AS resolves,
      current_setting('search_path') AS search_path, current_user AS role,
      current_database() AS database
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector'`)
  const row = rows[0]
  if (!row) return { status: "absent" }
  if (row.resolves) return { status: "ok", schema: row.schema }

  const current = row.search_path.trim()
  const searchPath = current ? `${current}, ${ident(row.schema)}` : ident(row.schema)
  await client.query(
    `ALTER ROLE CURRENT_USER IN DATABASE ${ident(row.database)} SET search_path TO ${searchPath}`,
  )
  await client.query(`SET search_path TO ${searchPath}`)
  const check = await client.query<{ resolves: boolean }>(
    "SELECT to_regtype('vector') IS NOT NULL AS resolves",
  )
  if (!check.rows[0]?.resolves) {
    throw new Error(
      `pgvector is installed in schema "${row.schema}", but its "vector" type still does not resolve for role "${row.role}"`,
    )
  }
  return { status: "fixed", schema: row.schema, role: row.role, database: row.database, searchPath }
}
