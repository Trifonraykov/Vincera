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

## Fake services

Outside production, every external service runs a fake implementation when its credentials are missing, and `FAKE_SERVICES=all` (the `.env.example` default) or a comma list such as `stripe,social` forces fakes. The server logs which services are fake when it starts. Fakes keep their state in the database or under `.data/` (gitignored):

| Service | Fake |
|---|---|
| Email (Resend) | One JSON file per email in `.data/outbox/` |
| Storage (Cloudflare R2) | Files under `.data/storage/`, served through signed, expiring `/api/dev/storage/*` URLs |
| Stripe | Fake checkout, Connect onboarding and transfers; webhooks are signed with `STRIPE_WEBHOOK_SECRET` and go through the real handler (built with Phases 1 and 4) |
| Social providers | A fake authorize page and fixture profile and audience data (built with Phase 1) |
| Claude / embeddings | Deterministic stub output / hashed bag-of-words vectors |
| Jobs (Inngest) | Handlers run in-process right after the request |
| Rate limiting (Upstash) | In-memory, per process |
| Sentry / PostHog | Off unless a DSN / key is set |

**Signing in locally:** sign-in is by email magic link (plus Google / GitHub once their `AUTH_*` credentials are set). With the fake email service nothing is sent: open the newest file in `.data/outbox/` and follow its `/api/auth/callback/email?...` link. See `CLAUDE.md` §19.3 and §19.9.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev server, production build, production server |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit`, ESLint |
| `pnpm format` / `pnpm format:check` | Prettier (write / check) |
| `pnpm test` | Vitest: the `unit` and `integration` projects (`pnpm test:unit`, `pnpm test:integration`) |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm db:generate` | Generate a Drizzle migration from `lib/db/schema` (`--custom --name <name>` for hand-written SQL) |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm db:reset` | Drop, re-create and migrate the `DATABASE_URL` database (never in production) |
| `pnpm db:seed` | Seed demo data (placeholder until Phase 2) |
| `pnpm admin:grant <email>` | Give an existing user the admin role (audited) |
| `pnpm stripe:listen` | Forward Stripe test webhooks to the local app (Stripe CLI) |
| `pnpm inngest:dev` | Run the Inngest dev server against the local app |
| `pnpm email:dev` | Preview email templates (`lib/email/templates`) on port 3001 |
| `pnpm ledger:check` | Reconcile the ledger against orders and Stripe transfers |

## Tests

- **Unit** (`tests/unit`) need nothing else.
- **Integration** (`tests/integration`) run against real Postgres. `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`) is a maintenance connection whose user may create databases: each run builds a migrated template database (`ct_tpl_*`), and each test file works in its own clone (`ct_*`), dropped afterwards.
- **End-to-end** (`tests/e2e`, Playwright, Chromium). Install the browser once with `pnpm exec playwright install chromium`. Each run drops, re-creates, migrates and seeds `E2E_DATABASE_URL` (default `creator_e2e`; the name must contain `e2e` or `test` as a whole word) and empties `.data/`. It then drives `pnpm dev` on port 3100 (`PORT` to change it; a server already listening there is reused) with `FAKE_SERVICES=all`, reading magic links from the fake outbox. `CI=1 pnpm test:e2e` runs `pnpm build && pnpm start` instead.

`TEST_DATABASE_URL` and `E2E_DATABASE_URL` are read from the environment or `.env.local`. Both must point at a Postgres on this machine, because the tests create and drop databases there; set `ALLOW_REMOTE_TEST_DB=1` to use another server that holds only test databases.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request with a `pgvector/pgvector:pg17` service: install (frozen lockfile), typecheck, lint, `pnpm test`, `pnpm build`, then Playwright. All services are fake (`APP_ENV=test`, `FAKE_SERVICES=all`) and the secrets are test-only values. The Playwright report is uploaded when the job fails.

Before opening a pull request, run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`.
