# Run the platform locally with Docker

One command starts Postgres (with pgvector) and the app, with every external service faked:

```bash
docker compose up --build
```

Then open <http://localhost:3000>. The port is published on `127.0.0.1` only: with every
service fake and the dev mailbox on (`DEV_MAILBOX=1`), anyone who could reach it could sign in as
any user, admin included. Do not expose this setup to a network.

- **Sign in / sign up:** enter any email. No real email is sent: open the dev mailbox at
  <http://localhost:3000/api/dev/mailbox> and click the magic link.
- **Admin:** sign up as `admin@example.com` (or set `ADMIN_EMAILS=you@example.com` before
  `docker compose up`) and open <http://localhost:3000/admin>.
- **Social accounts and payouts:** the "Connect YouTube/GitHub/…" buttons and Stripe onboarding open
  fake consent pages that feed recorded test data through the real code.
- **Updating:** `git pull && docker compose up --build`. Migrations and the (idempotent) seed run on
  every start.
- **Reset everything:** `docker compose down -v` deletes the database and the app's local data.

Secrets for this local setup are generated on first start and kept in the `appdata` volume. This
image is for local testing only, not for production.
