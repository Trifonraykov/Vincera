# Run the platform locally with Docker

One command starts Supabase's Postgres (with pgvector) and the app, with every external service
faked:

```bash
./launch.sh                  # Windows: docker compose up --build
```

`./launch.sh` checks that Docker is running, prints which database it will use (the local
container, or the host of a hosted Supabase project: never the password), runs
`docker compose up --build`, and prints the URLs. Extra arguments go to `docker compose up`
(`./launch.sh -d` runs in the background).

Then open <http://localhost:3000>. The port is published on `127.0.0.1` only: with every
service fake and the dev mailbox on (`DEV_MAILBOX=1`), anyone who could reach it could sign in as
any user, admin included. Do not expose this setup to a network.

- **Sign in / sign up:** enter any email. No real email is sent: open the dev mailbox at
  <http://localhost:3000/api/dev/mailbox> and click the magic link.
- **Admin:** sign up as `admin@example.com` (or set `ADMIN_EMAILS=you@example.com` in `.env`)
  and open <http://localhost:3000/admin>.
- **Social accounts and payouts:** the "Connect YouTube/GitHub/…" buttons and Stripe onboarding open
  fake consent pages that feed recorded test data through the real code.
- **Database:** the `db` service runs `supabase/postgres` (the image Supabase's CLI and hosted
  projects use), so the migrations and the post-migrate hardening run exactly as on Supabase. To use
  a hosted Supabase project instead, set `DATABASE_URL` (and optionally `DATABASE_SSL`,
  `DATABASE_CA_CERT`) in a `.env` file at the repository root; `./launch.sh` then starts only the
  app. Step by step: [`docs/supabase.md`](../docs/supabase.md).
- **Updating:** `git pull && ./launch.sh`. Migrations, the Supabase hardening and the (idempotent)
  seed run on every start. A database that is not reachable yet is retried for two minutes; a
  wrong password, a TLS problem or a failing migration stops the start with the error.
- **Reset everything:** `docker compose down -v` deletes the database and the app's local data.
  Setups from before the switch to Supabase's image kept their data in a `pgdata` volume, which is
  no longer used: `docker volume rm creator-platform_pgdata` frees the space.

The first start downloads Supabase's Postgres image (about 1.7 GB on disk) and builds the app,
which takes a few minutes; later starts reuse both.

## Install it as an app

The app is a mobile-first web app that installs like a native one. This setup runs a production
build, so the service worker (offline page) is on.

- **On this computer:** open <http://localhost:3000> in Chrome or Edge, sign in, and click
  **Install** on the card at the bottom of the app's home page (or the install icon in the address
  bar). Safari on a Mac: File → Add to Dock.
- **On an Android phone:** connect it by USB with USB debugging on, run
  `adb reverse tcp:3000 tcp:3000` (or use Chrome's `chrome://inspect` → Port forwarding), then open
  <http://localhost:3000> in Chrome on the phone and tap **Install**. The phone's `localhost` is
  forwarded to this computer, so the app stays unreachable from the network.
- **On an iPhone (or any phone over Wi-Fi):** phones need https to install the app, and this setup
  answers only on this computer at `http://localhost:3000`. Use `pnpm build && pnpm start` with a
  tunnel instead: the README's "Install it on a computer or a phone" has the steps.

Secrets for this local setup are generated on first start and kept in the `appdata` volume; set
`AUTH_SECRET` and `ENCRYPTION_KEY` in `.env` to use your own (needed when `pnpm dev` shares the
same hosted database: both must encrypt with the same key). This image is for local testing only,
not for production.
