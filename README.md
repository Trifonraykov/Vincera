# Vincera Bot

Autonomous AI agent system that installs on a company's machine, maps the business, researches the industry, observes for 7 days, then deploys sub-agents to automate operations.

## What It Does

Vincera follows a structured pipeline: **Discovery** scans the company's systems (filesystems, databases, networks, spreadsheets) and builds a comprehensive company model. **Research** studies the industry and finds best practices, academic papers, and case studies relevant to the business. During a 7-day **Ghost Mode**, the system observes operations and generates daily reports on what it *would* automate — without touching anything.

After the observation period, Vincera transitions to **Active Mode**. The Orchestrator runs an OODA loop (Observe-Orient-Decide-Act), dispatching 7 specialized agents: Discovery, Research, Builder, Operator, Analyst, Unstuck, and Trainer. The Builder generates automation scripts that pass through a 4-stage deployment pipeline (sandbox, shadow, canary, full) with 6-check verification at each gate.

The **Dashboard** is the sole user interface — a Next.js application connected to Supabase. There is no separate chat app or webhook integration. All communication flows through Supabase: agents write messages and status updates, the dashboard reads them via Realtime subscriptions, and users send commands back through the messages table.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Next.js Dashboard                   │
│  (Agents, Brain View, Automations, Decisions,   │
│   Knowledge, Research, Ghost Mode, Logs)         │
└────────────────────┬────────────────────────────┘
                     │  Supabase Realtime + REST
                     ▼
┌─────────────────────────────────────────────────┐
│                 Supabase                         │
│  15 tables │ RLS policies │ Realtime │ Functions │
└────────────────────┬────────────────────────────┘
                     │  supabase-py (service role)
                     ▼
┌─────────────────────────────────────────────────┐
│              Vincera Agent (Python)              │
│  Orchestrator → 7 Agents → Verification →       │
│  Sandbox → Shadow → Canary → Full Deploy        │
└─────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+ and npm
- Docker (for sandbox execution)
- A [Supabase](https://supabase.com) project (free tier works)
- An [OpenRouter](https://openrouter.ai) API key

### 1. Clone and Install Agent

```bash
git clone <repo-url> && cd vincera-bot/Vincera
pip install -e .
```

### 2. Configure

```bash
vincera install
# Interactive setup: asks for Supabase URL, keys, OpenRouter key, company name
# Encrypts secrets with Fernet, stores in ~/VinceraHQ/config.json
```

### 3. Run Supabase Migrations

```bash
cd supabase
npx supabase link --project-ref <your-project-ref>
npx supabase db push
# Or manually: apply each file in supabase/migrations/ in order via SQL editor
```

### 4. Start the Agent

```bash
vincera start
# Installs as system service: systemd (Linux), launchd (macOS), NSSM (Windows)

# Or run directly:
python -m vincera.main
```

### 5. Start the Dashboard

```bash
cd ../dashboard
npm install
cp .env.local.example .env.local
# Edit .env.local with your Supabase URL and anon key (NOT service key)
npm run dev
# Open http://localhost:3000
```

## Running Tests

```bash
# Python agent tests (from Vincera/ directory)
cd Vincera
source .venv/bin/activate
pytest -v

# Dashboard build check
cd ../dashboard
npm run build
```

## Project Structure

```
Vincera/
├── vincera/                 # Python agent
│   ├── agents/              # 7 specialized agents + base class
│   ├── builder/             # Code generation, review, testing
│   ├── core/                # Orchestrator, authority, LLM, state
│   ├── discovery/           # System and business discovery
│   ├── execution/           # Sandbox, shadow, canary, deployment
│   ├── knowledge/           # Playbook and Supabase client
│   ├── research/            # Business research and validation
│   ├── training/            # Agent learning and corrections
│   ├── utils/               # Logging, errors, crypto, resources
│   ├── verification/        # 6-check verification pipeline
│   ├── config.py            # Pydantic settings with Fernet encryption
│   └── main.py              # CLI entry point
├── tests/                   # 553 tests
├── supabase/migrations/     # 17 SQL migration files
└── dashboard/               # Next.js dashboard
    ├── src/app/dashboard/   # 13 routes
    ├── src/components/      # 42 React components
    ├── src/hooks/           # 12 data-fetching hooks
    └── src/contexts/        # Global dashboard state
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, agents, data layer, verification pipeline
- [Deployment Guide](docs/DEPLOYMENT.md) — Supabase, agent, and dashboard deployment
- [Contributing](docs/CONTRIBUTING.md) — adding agents, pages, and tables
- [Testing](docs/TESTING.md) — test structure, fixtures, and E2E scenarios

## License

See LICENSE file.

---

# Creator x Builder platform

The repository root is also a Next.js app: a two-sided platform where creators and builders co-create and sell small digital products. The full build spec is [`CLAUDE.md`](./CLAUDE.md); decisions made during the build are in its §19. The legacy Vincera Bot above (`vincera/`, `dashboard/`, `supabase/`, Python tests) is separate: the platform's TypeScript, ESLint, Vitest and Next.js config ignore it.

## Prerequisites

- Node.js 22+ and pnpm 10 (`corepack enable` picks the version pinned in `package.json`).
- PostgreSQL 16+ with the [pgvector](https://github.com/pgvector/pgvector) extension available. The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the database user must be allowed to create it (the default `postgres` superuser is). Either:
  - Docker: `docker run -d --name creator-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17`
  - or a local server plus the pgvector package (for example `postgresql-16-pgvector` on Debian/Ubuntu).

## Quick start with Docker

```bash
docker compose up --build    # http://localhost:3000
```

This starts Postgres with pgvector and the app, with every external service faked. Sign in with any email and click the magic link in the dev mailbox at <http://localhost:3000/api/dev/mailbox>. Sign up as `admin@example.com` for admin access. The port is published on `127.0.0.1` only: with everything fake and the mailbox on, anyone who could reach it could sign in as any user. See [`docker/README.md`](./docker/README.md) for updating and resetting.

## Local setup

```bash
pnpm install
cp .env.example .env.local   # then set AUTH_SECRET and ENCRYPTION_KEY (see below)
pnpm db:reset                # creates the DATABASE_URL database (default creator_dev) and migrates it
pnpm dev                     # http://localhost:3000
```

Generate the two secrets with `openssl rand -base64 32` each. Later, after pulling new migrations, run `pnpm db:migrate` (it does not create the database). `pnpm db:reset` drops existing data and refuses non-local hosts unless `--force` is passed.

## Environment

All variables are listed in [`.env.example`](./.env.example) (its first block belongs to the legacy bot and is ignored by the platform). `lib/env.ts` validates the environment with Zod when the server starts: a misconfigured `next start` prints every problem and exits.

- Always required: `DATABASE_URL`, `AUTH_SECRET` (32+ characters), `ENCRYPTION_KEY` (32 bytes, base64) and `STRIPE_WEBHOOK_SECRET` (the example value works locally).
- `APP_ENV` (`development` | `test` | `production`) defaults from `NODE_ENV`. In production every external credential is required and fakes are refused.
- `ADMIN_EMAILS` (comma list) get the admin role when they sign up. For an existing account: `pnpm admin:grant <email>`.
- `STRIPE_CONNECT_WEBHOOK_SECRET` (the Connect endpoint's signing secret) is required in production; elsewhere it falls back to `STRIPE_WEBHOOK_SECRET`. `YOUTUBE_LONG_RETENTION` (default `false`) keeps YouTube statistics beyond 30 days; see `CLAUDE.md` §19.10.
- `SOCIAL_OAUTH_DISABLED` (comma list, e.g. `instagram,tiktok`) switches off a provider whose app review is still pending: its Connect buttons are hidden, creators enter numbers by hand, and its credentials are not required in production (`CLAUDE.md` §19.14).
- `DATABASE_CA_CERT` (PEM) turns on verified TLS for a hosted database such as Supabase (see below).
- `DEV_MAILBOX=1` (never in production) serves the fake outbox at `/api/dev/mailbox`, so magic links can be clicked in the browser. Anyone who can reach the dev server can then sign in as any user, so use it only on a machine and network you trust.

## Database on Supabase

The platform runs on any Postgres 16+ with pgvector, Supabase included. It talks to the database directly (Drizzle over `pg`) and does not use Supabase's client libraries or its Data API.

1. Create a Supabase project **for the platform alone**. The legacy bot's project cannot be shared: both have `events` and `messages` tables in `public`.
2. In the project's **Connect** dialog, copy a pooler connection string. Use the **transaction pooler** (port 6543) for serverless hosting such as Vercel, or the **session pooler** (port 5432) for a long-running `pnpm start` or Docker. The direct `db.<ref>.supabase.co` host is IPv6-only unless the project has the IPv4 add-on.
3. Under **Database settings → SSL configuration**, download the CA certificate and put its contents in `DATABASE_CA_CERT` (a one-line value with `\n` escapes works). Connections then use TLS and verify the server. Production refuses a Supabase `DATABASE_URL` without that certificate (or an `sslrootcert` file in the URL): node-postgres treats `sslmode=require` like `verify-full`, which fails against Supabase's own CA, and `sslmode=no-verify` would not check the server.
4. Apply the migrations once, with the session pooler URL: `DATABASE_URL=<session pooler url> DATABASE_CA_CERT="$(cat prod-ca-2021.crt)" pnpm db:migrate`. They enable `vector`, create the tables and triggers, turn on row-level security for every table and revoke the `anon` / `authenticated` roles' access, so the auto-generated Data API can neither list nor read anything (the app's own `postgres` role owns the tables and is not restricted). You can also switch the Data API off in the project settings, since nothing uses it.
5. Set `DATABASE_URL` (and `DATABASE_CA_CERT`) in the deployment and start the app.

To check a change against Supabase's own Postgres locally (the image `supabase start` uses, with the same roles and default privileges as a hosted project): `docker run -d --name supabase-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54322:5432 supabase/postgres:17.11.0.003`, then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm db:migrate` and `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm test:integration`. CI runs the same checks in its `supabase-postgres` job. `pnpm db:reset` is for local databases only.

## Fake services

Outside production, every external service runs a fake implementation when its credentials are missing, and `FAKE_SERVICES=all` (the `.env.example` default) or a comma list such as `stripe,social` forces fakes. The server logs which services are fake when it starts. Fakes keep their state in the database or under `.data/` (gitignored):

| Service | Fake |
|---|---|
| Email (Resend) | One JSON file per email in `.data/outbox/` |
| Storage (Cloudflare R2) | Files under `.data/storage/`, served through signed, expiring `/api/dev/storage/*` URLs |
| Stripe | Fake Connect onboarding (`/api/dev/fake-stripe/*`) that posts signed `account.updated` webhooks to the real handler; fake checkout and transfers arrive with Phases 4–5 |
| Social providers | A fake consent page per provider (`/api/dev/fake-oauth/<provider>/authorize`, "Authorize as <fixture account>") that redirects to the real OAuth callback; recorded API responses (`tests/fixtures/social/`) go through the real parsers |
| Claude / embeddings | Deterministic stub output / hashed bag-of-words vectors |
| Jobs (Inngest) | Handlers run in-process right after the request |
| Rate limiting (Upstash) | In-memory, per process |
| Sentry / PostHog | Off unless a DSN / key is set |

**Signing in locally:** sign-in is by email magic link, whose email also carries an 8-character code that can be typed instead (plus Google / GitHub once their `AUTH_*` credentials are set). With the fake email service nothing is sent: open the newest file in `.data/outbox/` and follow its `/api/auth/callback/email?...` link, or set `DEV_MAILBOX=1` and click it at <http://localhost:3000/api/dev/mailbox>. See `CLAUDE.md` §19.3 and §19.9.

**On a phone:** the app is built mobile-first and behaves like an app. Signed in, a bottom tab bar holds the main places (Home, then Audience, Profile and Payouts for creators or Profile, Connections and Payouts for builders until Products, Discover and Collabs are built, and More for the full menu), forms keep their main button in a bar above it, and dark mode follows the phone. Pages that later phases build show "Coming soon" inside the app, with the menu and tab bar still there. It ships a web app manifest, so "Add to Home Screen" (iOS Safari) or "Install app" (Chrome on Android) puts it on the home screen, where it opens full screen straight into `/app`. On iOS the installed app keeps its own cookies, apart from Safari's, so tapping the email's link in Mail signs Safari in, not the app: type the **sign-in code** from the same email into the app instead (it appears under "Check your email", or "Have a sign-in code?" on the sign-in page). To try it from a phone on your network, set `NEXT_PUBLIC_APP_URL` and `AUTH_URL` to `http://<your computer's IP>:3000` (links and OAuth redirects use them), run `pnpm dev` and open that address on the phone. Installing to the home screen needs https (a deployment or a tunnel).

**What works so far (Phase 1):** sign up, pick creator, builder or both, and walk onboarding: profile (handle, niche, languages / skills, stack, availability), connect YouTube, Instagram or TikTok (or enter numbers by hand), review the AI audience summary, GitHub and portfolio for builders, then Stripe payouts. Then `/app/audience`, Settings (profile, connections, payouts, notifications, account) and the public profiles at `/c/<handle>` and `/b/<handle>`. With fakes, every connection and the payouts onboarding work offline. Real provider apps need their credentials in `.env.local`; each provider's redirect URI is `<NEXT_PUBLIC_APP_URL>/api/oauth/<provider>/callback`. Background jobs (`social/sync`, the daily resync and YouTube retention) run in-process when Inngest is fake.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev server, production build, production server |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit`, ESLint |
| `pnpm format` / `pnpm format:check` | Prettier (write / check) |
| `pnpm test` | Vitest: the `unit` and `integration` projects (`pnpm test:unit`, `pnpm test:integration`) |
| `pnpm test:e2e` | Playwright end-to-end tests (`CI=1 pnpm test:e2e` builds and runs `next start`) |
| `pnpm db:generate` | Generate a Drizzle migration from `lib/db/schema` (`--custom --name <name>` for hand-written SQL) |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm db:reset` | Drop, re-create and migrate the `DATABASE_URL` database (never in production) |
| `pnpm db:seed` | Seed demo data (placeholder until Phase 2) |
| `pnpm admin:grant <email>` | Give an existing user the admin role (audited) |
| `pnpm stripe:listen` | Forward Stripe test webhooks, platform and Connect, to the local app (Stripe CLI) |
| `pnpm inngest:dev` | Run the Inngest dev server against the local app |
| `pnpm email:dev` | Preview email templates (`lib/email/templates`) on port 3001 |
| `pnpm ledger:check` | Reconcile the ledger against orders and Stripe transfers |

## Tests

- **Unit** (`tests/unit`) need nothing else.
- **Integration** (`tests/integration`) run against real Postgres. `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`) is a maintenance connection whose user may create databases: each run builds a migrated template database (`ct_tpl_*`), and each test file works in its own clone (`ct_*`), dropped afterwards.
- **End-to-end** (`tests/e2e`, Playwright, Chromium). Install the browser once with `pnpm exec playwright install chromium`. Each run drops, re-creates, migrates and seeds `E2E_DATABASE_URL` (default `creator_e2e`; the name must contain `e2e` or `test` as a whole word) and empties `.data/`. It then drives `pnpm dev` on port 3100 (`PORT` to change it; a server already listening there is reused) with `FAKE_SERVICES=all`, reading magic links from the fake outbox. `CI=1 pnpm test:e2e` runs `pnpm build && pnpm start` instead. Specs can run a background job under a mocked clock through the test-only `POST /api/test/jobs/<job id>` route (`runJob` in `tests/e2e/helpers/jobs.ts`).

`TEST_DATABASE_URL` and `E2E_DATABASE_URL` are read from the environment or `.env.local`. Both must point at a Postgres on this machine, because the tests create and drop databases there; set `ALLOW_REMOTE_TEST_DB=1` to use another server that holds only test databases.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request with a `pgvector/pgvector:pg17` service: install (frozen lockfile), typecheck, lint, `pnpm test`, `pnpm build`, then Playwright. All services are fake (`APP_ENV=test`, `FAKE_SERVICES=all`) and the secrets are test-only values. The Playwright report is uploaded when the job fails. A second job, `supabase-postgres`, applies the migrations to Supabase's Postgres image, checks that the Data API roles see no tables, and runs the integration tests there.

Before opening a pull request, run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`.
