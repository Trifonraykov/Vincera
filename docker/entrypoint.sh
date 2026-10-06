#!/bin/sh
# Starts the platform for local testing: generates and keeps local secrets, waits for Postgres,
# applies migrations, runs the (idempotent) seed, then runs `next start` on port 3000.
set -eu

SECRETS_FILE=/app/.data/local-secrets.env
mkdir -p /app/.data
if [ ! -f "$SECRETS_FILE" ]; then
  echo "Generating local secrets in $SECRETS_FILE"
  node -e '
    const { randomBytes } = require("node:crypto")
    console.log("AUTH_SECRET=" + randomBytes(32).toString("base64"))
    console.log("ENCRYPTION_KEY=" + randomBytes(32).toString("base64"))
  ' > "$SECRETS_FILE"
fi
# Values passed in the environment win over the generated ones.
while IFS='=' read -r key value; do
  eval "current=\${$key:-}"
  if [ -z "$current" ]; then export "$key=$value"; fi
done < "$SECRETS_FILE"

# db:migrate prints which database it uses (host only, never the password), applies the
# migrations, then the Supabase hardening. It exits 75 while the database is not reachable yet
# (retried here) and 1 for anything retrying cannot fix (wrong password, TLS, a bad migration).
echo "Waiting for the database and applying migrations..."
attempt=0
while :; do
  status=0
  pnpm -s db:migrate || status=$?
  if [ "$status" -eq 0 ]; then break; fi
  if [ "$status" -ne 75 ]; then
    echo "Migrations failed (see above); check DATABASE_URL and the README's \"Database on Supabase\"." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo "Database not reachable after 2 minutes, giving up." >&2; exit 1; fi
  sleep 2
done

# The seed is idempotent, so it runs on every start and picks up new demo data after an update.
echo "Seeding demo data..."
pnpm -s db:seed || echo "Seed failed; continuing without demo data." >&2

cat <<MSG

  Creator x Builder platform is running: http://localhost:3000
  Sign in with any email, then open the dev mailbox to click the magic link:
    http://localhost:3000/api/dev/mailbox
  Admin access: sign up with an address listed in ADMIN_EMAILS (default admin@example.com).

MSG

exec node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
