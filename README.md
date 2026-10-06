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

**Desktop app:** download the installer for macOS, Windows or Linux and double-click it: no Docker, terminal or database to install. See [`desktop/README.md`](./desktop/README.md).

## Prerequisites

- Node.js 22+ and pnpm 10 (`corepack enable` picks the version pinned in `package.json`).
- PostgreSQL 16+ with the [pgvector](https://github.com/pgvector/pgvector) extension available. The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the database user must be allowed to create it (the default `postgres` superuser is). Either:
  - Docker: `docker run -d --name creator-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17`
  - or a local server plus the pgvector package (for example `postgresql-16-pgvector` on Debian/Ubuntu).

## Quick start with Docker

```bash
./launch.sh                  # http://localhost:3000   (Windows: docker compose up --build)
```

This needs only Docker (Docker Desktop, or Docker Engine with Compose v2); no Node.js, pnpm or Postgres on your computer. `./launch.sh` checks that Docker is running, says which database it will use, then runs `docker compose up --build`: Supabase's own Postgres image in a container plus the app, with every external service faked. To use a hosted Supabase project instead, put its connection string in `.env` (see [Database on Supabase](#database-on-supabase)). Sign in with any email and click the magic link in the dev mailbox at <http://localhost:3000/api/dev/mailbox>. Sign up as `admin@example.com` for admin access. The port is published on `127.0.0.1` only: with everything fake and the mailbox on, anyone who could reach it could sign in as any user. See [`docker/README.md`](./docker/README.md) for updating, resetting and installing it as an app.

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
- `DATABASE_SSL`, `DATABASE_CA_CERT` and `DATABASE_POOL_MAX` set the database's TLS and pool size (see [Database on Supabase](#database-on-supabase)).
- `DEV_MAILBOX=1` (never in production) serves the fake outbox at `/api/dev/mailbox`, so magic links can be clicked in the browser. Anyone who can reach the dev server can then sign in as any user, so use it only on a machine and network you trust.

## Database on Supabase

The platform runs on any Postgres 16+ with pgvector, and Supabase is the intended host. It talks to the database directly (Drizzle over `pg`) and uses none of Supabase's client libraries, auth or Data API. The full guide (click paths, TLS, backups, troubleshooting) is [`docs/supabase.md`](./docs/supabase.md); decisions are in `CLAUDE.md` §19.21.

- **Hosted project:** create a Supabase project for the platform alone, click **Connect**, copy the **Session pooler** connection string (IPv4), put it in `.env` as `DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres'`, and run `./launch.sh`. For `pnpm dev`, put it in `.env.local` and run `pnpm db:migrate` once. Tables appear in the dashboard's Table Editor under `public`.
- **TLS:** Supabase hosts are encrypted by default (`DATABASE_SSL=require`). Set `DATABASE_CA_CERT` to the CA certificate from Project Settings → Database → SSL Configuration (a file path or the PEM text) and the server is verified too (`verify-full`); production requires it. `DATABASE_SSL=disable|require|verify-full` overrides the URL's `sslmode`, and `DATABASE_POOL_MAX` (default 10) sizes the app's pool. Other hosts (Neon, RDS, …) keep node-postgres's meaning of `sslmode=require` (the server is verified), and production refuses any remote database that is not verified unless `DATABASE_SSL=require` says so.
- **Locked-down Data API:** after every migration, `pnpm db:migrate` switches row-level security on for every table and revokes Supabase's `anon` / `authenticated` roles' grants and `PUBLIC`'s (and their default privileges), so the project's public anon key can read nothing and call no function. On plain Postgres this step does nothing. It refuses, untouched, a database that already holds another app's objects (`DATABASE_ALLOW_FOREIGN_OBJECTS=1` overrides).
- **Local Supabase with Studio:** `pnpm supabase:start` (the Supabase CLI, pinned, with its project in `supabase-local/`, not the legacy `supabase/` folder) runs the database on `localhost:54322` and Studio on <http://localhost:54323>. Use `DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres`, then `pnpm db:migrate` and `pnpm dev`. `pnpm supabase:status` / `pnpm supabase:stop`.
- **Switching back** to the local Docker database: remove `DATABASE_URL` from `.env` and run `./launch.sh`.

## Fake services

Outside production, every external service runs a fake implementation when its credentials are missing, and `FAKE_SERVICES=all` (the `.env.example` default) or a comma list such as `stripe,social` forces fakes. The server logs which services are fake when it starts. Fakes keep their state in the database or under `.data/` (gitignored):

| Service | Fake |
|---|---|
| Email (Resend) | One JSON file per email in `.data/outbox/` |
| Storage (Cloudflare R2) | Files under `.data/storage/`, served through signed, expiring `/api/dev/storage/*` URLs |
| Stripe | Fake Connect onboarding, a fake Checkout page (`/api/dev/fake-stripe/*`: test card, a fee that settles later, delayed and failing methods) and fake transfers, refunds and disputes, kept as Stripe-shaped JSON under `.data/fake-stripe/`; every event is signed and posted to the real `/api/webhooks/stripe` handler |
| Social providers | A fake consent page per provider (`/api/dev/fake-oauth/<provider>/authorize`, "Authorize as <fixture account>") that redirects to the real OAuth callback; recorded API responses (`tests/fixtures/social/`) go through the real parsers |
| Claude / embeddings | Deterministic stub output / hashed bag-of-words vectors |
| Jobs (Inngest) | Handlers run in-process right after the request |
| Rate limiting (Upstash) | In-memory, per process |
| Sentry / PostHog | Off unless a DSN / key is set |

**Signing in locally:** sign-in is by email magic link, whose email also carries an 8-character code that can be typed instead (plus Google / GitHub once their `AUTH_*` credentials are set). With the fake email service nothing is sent: open the newest file in `.data/outbox/` and follow its `/api/auth/callback/email?...` link, or set `DEV_MAILBOX=1` and click it at <http://localhost:3000/api/dev/mailbox>. See `CLAUDE.md` §19.3 and §19.9.

**On a phone:** see [The phone app](#the-phone-app-pwa) below.

**What works so far (Phases 1–5):**
- **Phase 1:** sign up, pick creator, builder or both, and walk onboarding: profile (handle, niche, languages / skills, stack, availability), connect YouTube, Instagram or TikTok (or enter numbers by hand), review the AI audience summary, GitHub and portfolio for builders, then Stripe payouts. Then `/app/audience`, Settings (profile, connections, payouts, notifications, account) and the public profiles at `/c/<handle>` and `/b/<handle>`. Real provider apps need their credentials in `.env.local`; each provider's redirect URI is `<NEXT_PUBLIC_APP_URL>/api/oauth/<provider>/callback`.
- **Phase 2:** creators post ideas (`/app/ideas`, with an AI brief drafted from pasted audience comments), builders list products (`/app/products`); both are embedded and matched (matching v0, `CLAUDE.md` §8). `/app/discover` shows ranked matches with a one-sentence explanation, Save and Dismiss; `/app` shows top matches per role.
- **Phase 3:** proposals with counter-offers (`/app/proposals`), messages with attachments (`/app/messages`), notifications (`/app/notifications`, plus email), and collabs (`/app/collabs`): the v1 agreement (draft, pending legal review) signed by typing your name once both people have payouts set up, a PDF stored and emailed when both have signed, and tasks.
- **Phase 4:** once a collab is `building`, either member sets up the launch (`/app/collabs/<id>/launch`: title, price in EUR, description, images, and a delivery: files, license keys or a link), both approve, and an admin approves it at `/admin/launches` (or it goes live at once with `AUTO_APPROVE_LAUNCHES=true`). Going live opens the product page `/p/<slug>` ("by @creator × @builder") and gives the creator a tracked link `/r/<code>` (`/app/launches`, with an AI launch kit of post drafts). Buyers pay through Stripe Checkout (the fake page without keys) and get their purchase at `/access/<token>` (downloads through 5-minute signed links, the license key, or a redirect to the link), plus a receipt email.
- **Phase 5:** every sale is split in the ledger (VAT, Stripe fee, the platform's 10 %, then the members' shares by their signed split, to the cent) and held for 14 days. The daily payout job transfers available balances to each member's Stripe account; refunds and chargebacks reverse the shares (and the transfers already paid). `/app/earnings` shows available, held and paid-out money; `pnpm ledger:check` reconciles the ledger with orders and Stripe.
- With fakes everything above works offline; background jobs run in-process when Inngest is fake. To try a payout locally, run the job with a later clock: `curl -X POST localhost:3000/api/test/jobs/payouts-release -H 'content-type: application/json' -d '{"now":"<a date 15 days after the sale>"}'` with `E2E_TEST_ROUTES=1` set.

**Demo data:** `pnpm db:seed` (Docker runs it on every start; it only adds what is missing) creates 10 creators (`seed-creator-01@example.com` … `-10`) and 10 builders (`seed-builder-01@example.com` … `-10`) with profiles, connections, payouts, ideas, products, matches with explanations, and four collabs (01: `agreement`, signed by the creator only; 02: `ended`, cancelled before signing; 03: `live`, its launch "Printable checklist planner" approved by both and by the admin `seed-admin@example.com`; 04: `building`, signed by both, with tasks and messages). The live launch has three paid orders (two through the creator's tracked link, one with a €5 refund), all made through the fake Checkout and the real webhook and ledger code, so `pnpm ledger:check` passes on a fresh seed. Sign in as any of them with the fake mailbox above.

## The phone app (PWA)

The platform is a mobile-first web app that installs like a native one (native apps are out of scope, `CLAUDE.md` §1); the patterns for building pages are in `CLAUDE.md` §19.20.

- **On a phone**, the signed-in app has a bottom tab bar: Home, Discover, Collabs, Inbox and **Me**. Me lists everything else (your pages, settings, the role switch, your public profiles, appearance, sign out). A compact top bar shows the page title and a back button on nested pages. Forms keep their main button in a bar above the tabs. Desktop keeps the sidebar.
- **Installed:** it opens full screen, straight into `/app`, with shortcuts on a long press. The installed iPhone app keeps its own sign-in, apart from Safari's: type the **sign-in code** from the email into the app instead of tapping the link.
- **Offline:** a service worker (`public/sw.js`, production builds: Docker, `pnpm build && pnpm start`) shows an offline page when there is no connection and keeps the app's static files. It never stores pages or data, so nothing one person saw stays on a shared phone. To try it under `pnpm dev`, set `NEXT_PUBLIC_ENABLE_SW=1` (and back to unset afterwards: under `next dev` it would keep serving old code).
- **Icons:** `public/icons/` and `app/favicon.ico` are generated from the logo mark by `pnpm pwa:icons` and committed.
- **Tests:** the Playwright `mobile` project runs `tests/e2e/mobile*.spec.ts` on an iPhone-sized Chromium (`pnpm test:e2e --project=mobile`).

### Install it on a computer or a phone

Browsers install a web app, and run its service worker, only from a secure address: `https://…`, or `http://localhost` on the device itself. `http://192.168.x.x:3000` opened on a phone is not secure, so pick one of these:

| Where | How | What you get |
|---|---|---|
| **This computer** | Start the app (`./launch.sh`, or `pnpm build && pnpm start`), open <http://localhost:3000> in Chrome or Edge, sign in, and click **Install** on the card at the bottom of the app's home page (or the install icon in the address bar). Safari on a Mac: File → Add to Dock. | Its own window, straight into the app, with the offline page. |
| **Android phone, USB cable** | Turn on USB debugging (Settings → About phone → tap Build number 7 times, then Developer options → USB debugging), connect the phone, run `adb reverse tcp:3000 tcp:3000` (or Chrome's `chrome://inspect` → Port forwarding: `3000` → `localhost:3000`), open <http://localhost:3000> in Chrome on the phone and tap **Install**. Works with `./launch.sh` as it is: the phone's `localhost` is forwarded to this computer's, so nothing is opened to the network, and the dev mailbox opens on the phone too. | The full app, as on a deployment. |
| **iPhone, or any phone, over https** | Give the app an https address with a tunnel. Prefer a private one, such as [Tailscale Serve](https://tailscale.com/kb/1312/serve) (`tailscale serve --bg 3000` → `https://<computer>.<tailnet>.ts.net`, reachable only from your own devices); a public one (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) lets anyone with the address in. Run the app with `pnpm build && pnpm start` (Docker's address is fixed at `http://localhost:3000`), with `NEXT_PUBLIC_APP_URL` and `AUTH_URL` set to the https address in `.env.local` (rebuild when it changes: `NEXT_PUBLIC_*` values are built in). **Leave `DEV_MAILBOX` unset** on a public tunnel: anyone could read everyone's sign-in links there. Read your code from the newest file in `.data/outbox/` on the computer and type it on the phone. On the iPhone: Safari → Share → **Add to Home Screen**; Android: Chrome → **Install**. | The full app. |
| **Phone on the same Wi-Fi, plain http** | Same settings with `http://<this computer's IP>:3000`, then open that address on the phone. Only on a network you trust. | It works in the browser, but without the service worker: no offline page and no Install in Chrome. An iPhone can still Add to Home Screen. |

`pnpm build && pnpm start` runs with `NODE_ENV=production`, so with the fake services put `APP_ENV=development` in `.env.local` (Docker sets it). `./launch.sh` publishes the app on this computer only (`127.0.0.1:3000`) on purpose: every service is fake and the dev mailbox shows everyone's sign-in links.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev server, production build, production server |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit`, ESLint |
| `pnpm format` / `pnpm format:check` | Prettier (write / check) |
| `pnpm test` | Vitest: the `unit` and `integration` projects (`pnpm test:unit`, `pnpm test:integration`) |
| `pnpm test:e2e` | Playwright end-to-end tests: under `next dev` in 16 shards with a fresh server each (`scripts/e2e.ts`); `CI=1 pnpm test:e2e` builds and runs `next start` in one run |
| `pnpm db:generate` | Generate a Drizzle migration from `lib/db/schema` (`--custom --name <name>` for hand-written SQL) |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL`, then the Supabase hardening (a no-op on plain Postgres) |
| `pnpm db:reset` | Drop, re-create and migrate the `DATABASE_URL` database (never in production) |
| `pnpm db:seed` | Seed demo data, idempotent (steps in `lib/seed/`; refused when `APP_ENV=production`) |
| `pnpm admin:grant <email>` | Give an existing user the admin role (audited) |
| `pnpm supabase:start` / `supabase:stop` / `supabase:status` | Local Supabase database and Studio (Supabase CLI, project in `supabase-local/`) |
| `pnpm stripe:listen` | Forward Stripe test webhooks, platform and Connect, to the local app (Stripe CLI) |
| `pnpm inngest:dev` | Run the Inngest dev server against the local app |
| `pnpm email:dev` | Preview email templates (`lib/email/templates`) on port 3001 |
| `pnpm pwa:icons` | Render the app icons (`public/icons/`, `app/favicon.ico`) from the logo mark with Playwright's Chromium |
| `pnpm ledger:check` | Reconcile the ledger against orders and Stripe transfers |

## Tests

- **Unit** (`tests/unit`) need nothing else.
- **Integration** (`tests/integration`) run against real Postgres. `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`) is a maintenance connection whose user may create databases: each run builds a migrated template database (`ct_tpl_*`), and each test file works in its own clone (`ct_*`), dropped afterwards.
- **End-to-end** (`tests/e2e`, Playwright, Chromium). Install the browser once with `pnpm exec playwright install chromium`. Each run drops, re-creates, migrates and seeds `E2E_DATABASE_URL` (default `creator_e2e`; the name must contain `e2e` or `test` as a whole word) and empties `.data/`. It then drives `pnpm dev` on port 3100 (`PORT` to change it; a server already listening there is reused) with `FAKE_SERVICES=all`, reading magic links from the fake outbox. `CI=1 pnpm test:e2e` runs `pnpm build && pnpm start` instead. Specs can run a background job under a mocked clock through the test-only `POST /api/test/jobs/<job id>` route (`runJob` in `tests/e2e/helpers/jobs.ts`). Without `CI`, a whole-suite run is split into `E2E_DEV_SHARDS` (default 12) shards, each with a fresh dev server and an emptied `.next/dev`, because one `next dev` process outgrows a 13 GB container over the whole suite; pass spec files, `--shard`, or `E2E_DEV_SHARDS=1` for a single run. If `next dev` keeps growing in memory or is killed for running out of it, stop it and delete `.next/dev` (Turbopack's persistent dev cache, which is never pruned and grew past 6 GB here over many runs); the next start rebuilds it.

`TEST_DATABASE_URL` and `E2E_DATABASE_URL` are read from the environment or `.env.local`. Both must point at a Postgres on this machine, because the tests create and drop databases there; set `ALLOW_REMOTE_TEST_DB=1` to use another server that holds only test databases.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request with a `pgvector/pgvector:pg17` service: install (frozen lockfile), typecheck, lint, `pnpm test`, `pnpm build`, then Playwright. All services are fake (`APP_ENV=test`, `FAKE_SERVICES=all`) and the secrets are test-only values. The Playwright report is uploaded when the job fails. A second job, `supabase-postgres`, applies the migrations to Supabase's Postgres image, checks that the Data API roles see no tables, and runs the integration tests there.

Before opening a pull request, run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`.
