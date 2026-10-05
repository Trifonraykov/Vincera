# Database on Supabase

The platform keeps all its data in Postgres and talks to it directly (Drizzle over `pg`). Supabase
hosts that Postgres; the platform uses none of Supabase's client libraries, auth, storage or Data
API. Decisions behind this page: `CLAUDE.md` §19.21.

Three ways to run it:

|                   | Database                               | Command                                              |
| ----------------- | -------------------------------------- | ---------------------------------------------------- |
| Zero config       | Supabase's Postgres image in Docker    | `./launch.sh` (Windows: `docker compose up --build`) |
| Hosted            | Your Supabase project                  | `DATABASE_URL` in `.env`, then `./launch.sh`         |
| Local with Studio | The Supabase CLI's database and Studio | `pnpm supabase:start`, then `pnpm dev`               |

Whichever you pick, the app is at <http://localhost:3000>. To install it as an app on this
computer or a phone, see the README's "Install it on a computer or a phone".

## Use a hosted Supabase project

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**,
   for the platform alone. `pnpm db:migrate` refuses, without changing anything, a database that
   already holds another app's tables, views or functions in `public` (the legacy bot's project
   has `events` and `messages` there), because the migrations and the hardening below would
   change them; `DATABASE_ALLOW_FOREIGN_OBJECTS=1` overrides that if you really mean it. Pick the region closest to you and keep the
   database password: Project Settings → Database → **Reset database password** sets a new one.
2. **Copy the Session pooler connection string.** Click **Connect** at the top of the dashboard
   (the connection strings used to live under Project Settings → Database), choose **Session
   pooler**, and copy the URI:
   ```
   postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with the password, URL-encoding special characters (`@` → `%40`,
   `#` → `%23`, `/` → `%2F`, `:` → `%3A`).
   Why the session pooler: it works over IPv4 (Docker and most home networks have no IPv6) and
   keeps session features. The **direct** host `db.<ref>.supabase.co` is IPv6-only unless the
   project has the IPv4 add-on. The **transaction pooler** (port 6543) suits serverless hosting such
   as Vercel; the app works on it (it logs a one-time note), but run migrations through the session
   pooler.
3. **Put it in `.env`** at the repository root (gitignored; Docker Compose reads it):
   ```
   DATABASE_URL='postgresql://postgres.abcdefghijklmnopqrst:your-password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
   ```
   Keep the single quotes if the password contains `$`. A `DATABASE_URL` exported in your shell
   wins over `.env` (Compose's rule); `./launch.sh` tells you which one it uses.
4. **Launch:** `./launch.sh`. It checks Docker and prints the database it will use, e.g.
   `Database: Supabase session pooler at aws-1-eu-central-1.pooler.supabase.com:5432` (never the
   password). Then it builds and starts the app without the local database container, applies the
   migrations and the hardening (below), and serves <http://localhost:3000>. The dev mailbox is at
   <http://localhost:3000/api/dev/mailbox>.

Without Docker: put the same line in `.env.local` (it wins over `.env` for `pnpm dev` and the
scripts), then `pnpm db:migrate` and `pnpm dev`.

Using the project from both (`./launch.sh` and `pnpm dev`)? Also copy `AUTH_SECRET` and
`ENCRYPTION_KEY` from `.env.local` into `.env`. The Docker app otherwise generates its own, and
OAuth tokens one app encrypted cannot be read by the other (social syncs then fail until the
account is reconnected).

### Encryption (TLS)

Connections to Supabase hosts are encrypted by default (`require`): the traffic is private, but
the server's certificate is not checked. To also verify the server (required in production):

1. Project Settings → Database → **SSL Configuration** → **Download certificate**
   (`prod-ca-2021.crt`; Supabase signs its database certificates with this CA of its own, which
   Node does not trust by default).
2. Set `DATABASE_CA_CERT=./prod-ca-2021.crt` (a file path, or the PEM text itself; one line with
   `\n` escapes works). With a CA configured the server is always verified (`verify-full`).
   `./launch.sh` reads a file path for the container; with plain `docker compose up`, put the PEM
   text in `.env` instead: `DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----"`.

You can also switch on **Enforce SSL on incoming connections** in the same settings.

How the mode is chosen (`lib/db/connection.ts`), first match wins:

| Setting                                             | Result                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_SSL=disable \| require \| verify-full`    | that mode                                                                                                                                                                                      |
| TLS parameters in a Supabase `DATABASE_URL`         | libpq's meaning: `require`, `prefer`, `allow` and `no-verify` encrypt without verifying, `verify-ca` / `verify-full` verify (treated as `verify-full`), `disable` is plain text                |
| TLS parameters in any other `DATABASE_URL`          | node-postgres's meaning, as before: `require`, `prefer`, `allow`, `verify-ca`, `verify-full`, `ssl=true` and `sslnegotiation=direct` verify the server; `no-verify` encrypts without verifying |
| a Supabase host (`*.supabase.co`, `*.supabase.com`) | `require`                                                                                                                                                                                      |
| anything else (local Postgres, the Supabase CLI)    | `disable`                                                                                                                                                                                      |

A CA certificate (`DATABASE_CA_CERT`, or `sslrootcert` in the URL) upgrades any of these to
`verify-full`; next to an explicit `disable` it is a configuration error, and so is an unknown
`sslmode`, `ssl` or `sslnegotiation` value. The URL's own TLS parameters are removed before
node-postgres sees them, and `PGSSLMODE` / `PGSSLNEGOTIATION` are ignored, so the app,
`pnpm db:migrate`, the other scripts and drizzle-kit all behave the same.

**Production** (`APP_ENV=production`, or `NODE_ENV=production` without `APP_ENV`) refuses to start,
and `pnpm db:migrate`, `pnpm admin:grant` and drizzle-kit refuse to connect, unless a database
that is not on this machine is encrypted and verified: a Supabase server against
`DATABASE_CA_CERT`; any other server against Node's CAs or `DATABASE_CA_CERT`, or unverified only
when `DATABASE_SSL=require` says so on purpose. `localhost`, `127.0.0.1`, `::1` and Unix sockets
are exempt.

### Where the tables show up in Studio

Dashboard → **Table Editor**, schema `public`: `users`, `creator_profiles`, `social_connections`,
`events` and the rest (42 tables after Phase 1). The `drizzle` schema holds the migrations' journal.
Each table shows **RLS enabled** with no policies, which is intended (next section); the Security
Advisor lists that as information ("RLS Enabled No Policy"). It may also warn "Extension in
Public" for `vector`: migration 0000 installs pgvector into `public` unless it is already
enabled. To keep it in the `extensions` schema instead, enable **vector** there (Database →
Extensions) before the first migration; `pnpm db:migrate` then adds that schema to the role's
search_path when needed.

Change data through the app, not the Table Editor: `events`, `ledger_entries` and the other
append-only tables refuse updates and deletes, and other rows carry events and invariants the
app maintains.

### Why row-level security is on and the Data API is unused

Every Supabase project exposes the `public` schema through its Data API (PostgREST) to the `anon`
and `authenticated` roles, and the project's public **anon key** ships in every Supabase client
app. Supabase also grants those roles every table, sequence and function created in `public`, and
tables created with SQL start with row-level security off. Left like that, anyone with the anon
key could read and change every table: users, sessions, encrypted OAuth tokens, the ledger.

The platform never uses the Data API: the app connects as the tables' owner, the `postgres` role,
which row-level security does not restrict. So after every migration, `pnpm db:migrate` (and the
Docker entrypoint, which runs it on each start) **hardens** the database wherever those roles
exist:

- row-level security is switched on for every table in `public` and `drizzle`, with no policies,
  so the API roles see no rows even if a grant came back;
- every grant `anon` and `authenticated` hold on those tables, views, sequences and functions is
  revoked, and so is every grant to `PUBLIC`, which they inherit: PostgreSQL lets `PUBLIC`
  execute every new function, and PostgREST serves each function the anon role can execute at
  `/rest/v1/rpc/<name>` (pgvector's math functions, installed by Supabase's own admin role, are
  left alone: they read no table);
- the default privileges that would grant them future tables, sequences and functions are
  revoked too, including PostgreSQL's built-in `EXECUTE` for `PUBLIC` on new functions.

It prints a summary ending in "the Data API roles, directly or through PUBLIC, can read, change
or call nothing …", or a WARNING naming anything it could not fix. On plain Postgres it does nothing. Because it runs
after every migration, a table added by a later phase is covered without extra work. Checked with
Supabase's own stack (the CLI's gateway and PostgREST): with the anon role, every table answers
`permission denied` and the API lists no tables.

Because the hardening changes every object in `public`, it only runs on the platform's own
database: before migrating, `pnpm db:migrate` checks that the migrations journal
(`drizzle.__drizzle_migrations`) records the platform's migrations, or that `public` holds
nothing but extensions (a fresh project). Otherwise it stops with "Refusing to migrate database
… it already holds objects this platform did not create (…)" and changes nothing.

You can additionally turn the Data API off (Project Settings → Data API) or remove `public` from
its exposed schemas. Never share the **service_role** key: it bypasses all of this, and the
platform does not need it (nor the anon key).

### Switching back to the local database

Remove (or comment out) `DATABASE_URL` in `.env` and run `./launch.sh` again: the app uses the
local container, whose data is still in the Docker volume `creator-platform_supabase-db`. Data
does not move between the two; copy it with `pg_dump` / `pg_restore` (below) if you need to.

### Backups

- **Hosted:** paid plans take daily backups (Database → Backups) and offer point-in-time recovery.
  On any plan you can take your own with a Postgres 17 client:
  ```bash
  pg_dump "$DATABASE_URL" --no-owner --no-privileges --schema=public --schema=drizzle \
    --extension=vector -Fc -f platform.dump
  ```
  Restore into an empty database with
  `pg_restore --no-owner --no-privileges -d "<target url>" platform.dump`, then run
  `pnpm db:migrate` against the target: restored tables get the target project's default grants,
  and the hardening revokes them again (the restored journal marks the database as the
  platform's, so the check above lets it through).
- **Local Docker:** `docker compose exec db pg_dump -U postgres -d postgres -Fc > local.dump`.
  `docker compose down -v` deletes the local database.

## Local Supabase with Studio (Supabase CLI)

For browsing the data in Supabase Studio while developing:

```bash
pnpm supabase:start      # first run downloads the images; prints the URLs
```

- Database: `postgres://postgres:postgres@localhost:54322/postgres` (Supabase's Postgres, with
  the same roles as a hosted project).
- Studio: <http://localhost:54323> (Table Editor, SQL editor).

Put `DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres` in `.env.local`, then
`pnpm db:migrate` and `pnpm dev`. To run the Docker app against it instead, use
`DATABASE_URL=postgres://postgres:postgres@host.docker.internal:54322/postgres` in `.env` and
`./launch.sh` (inside the container `localhost` is the container itself).

- `pnpm supabase:status` shows the URLs; `pnpm supabase:stop` stops it and keeps the data
  (`pnpm supabase:stop --no-backup` deletes it).
- The CLI's project lives in `supabase-local/` (`supabase-local/supabase/config.toml`): only the
  database and Studio run (plus the gateway and postgres-meta Studio needs); auth, storage,
  realtime, edge functions, analytics, the mail catcher and the Data API are off. The legacy
  bot's `supabase/` folder is unrelated and never used.
- The CLI version is pinned in `package.json` (`supabase@2.119.0`, run with `pnpm dlx`); update
  it deliberately.
- It publishes its ports on every network interface with the password `postgres`: use it on a
  network you trust.
- Port 54322 busy? A container from older instructions (`docker run --name supabase-db …`) uses
  it: `docker stop supabase-db`.

## Settings

| Variable            | Default    |                                                                                                                    |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`      | (required) | Any `postgres://` URL. Docker: the local container unless set in `.env`.                                           |
| `DATABASE_SSL`      | see above  | `disable`, `require` or `verify-full`.                                                                             |
| `DATABASE_CA_CERT`  | unset      | PEM text or a file path; the server is then verified.                                                              |
| `DATABASE_POOL_MAX` | `10`       | Connections per app process (1–100). Supabase's poolers cap clients per plan; on serverless hosting keep it small. |

**Production** (`APP_ENV=production`) refuses a Supabase `DATABASE_URL` whose server is not
verified: set `DATABASE_CA_CERT`. Apply migrations before deploying, through the session pooler:
`DATABASE_URL=<session pooler url> DATABASE_CA_CERT=./prod-ca-2021.crt pnpm db:migrate`.

## Troubleshooting

| Message                                                                                    | Fix                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `password authentication failed`                                                           | Wrong password, or special characters not URL-encoded.                                                                                     |
| `Tenant or user not found`                                                                 | Pooler user names are `postgres.<project ref>`, and the pooler host must be your project's region. Copy the string again from **Connect**. |
| `self-signed certificate in certificate chain`                                             | Verification without Supabase's CA: set `DATABASE_CA_CERT` (or use `DATABASE_SSL=require`).                                                |
| `ENETUNREACH` / `ENOTFOUND` for `db.<ref>.supabase.co`                                     | The direct host is IPv6-only: use the Session pooler string.                                                                               |
| `The server does not support SSL connections`                                              | `DATABASE_SSL=require` against a local database (the Supabase CLI and the Docker container have TLS off): remove it.                       |
| `pgvector is installed in schema "extensions", which was not on the search_path …`         | Informational: `pnpm db:migrate` added that schema to the role's search_path for this database.                                            |
| `DATABASE_URL points at localhost, which inside the app container is the container itself` | Use `host.docker.internal` for a database on your computer.                                                                                |
