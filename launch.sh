#!/bin/sh
# Launch the Creator x Builder platform on this computer with Docker:
#
#   ./launch.sh            build and start, then open http://localhost:3000
#   ./launch.sh -d         the same in the background (stop with: docker compose down)
#
# Uses the local Supabase Postgres container, or a hosted Supabase project when DATABASE_URL is
# set in ./.env (see docs/supabase.md). Windows: run `docker compose up --build` instead.
# Extra arguments are passed to `docker compose up`.
set -eu

cd "$(dirname "$0")"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Get it from https://docs.docker.com/get-docker/ and run ./launch.sh again."
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop (or the Docker service) and run ./launch.sh again."
docker compose version >/dev/null 2>&1 || fail "This needs Docker Compose v2 (the \`docker compose\` command). Update Docker and try again."

# A setting the way Compose resolves it: the shell environment first, then ./.env.
setting() {
  name=$1
  if eval "[ -n \"\${$name+set}\" ]"; then
    eval "printf '%s' \"\${$name}\""
    return
  fi
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$name[[:space:]]*=[[:space:]]*//p" .env |
    tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}

database_url=$(setting DATABASE_URL)
project=$(setting COMPOSE_PROJECT_NAME)
if [ -z "$database_url" ]; then
  echo "Database: local Supabase Postgres container (Docker volume ${project:-creator-platform}_supabase-db)."
  echo "          To use a hosted Supabase project, see docs/supabase.md."
  local_db=1
else
  # Host and port only: never the user name or password.
  address=$(printf '%s' "$database_url" | sed -e 's#^[a-z]*://##' -e 's#^.*@##' -e 's#[/?].*$##')
  host=$(printf '%s' "$address" | sed -e 's#^\[\(.*\)\].*$#\1#' -e 't' -e 's#:[0-9]*$##')
  case "$host" in
    localhost | 127.0.0.1 | ::1 | 0.0.0.0)
      fail "DATABASE_URL points at $host, which inside the app container is the container itself.
Use host.docker.internal for a database on this computer (e.g. the Supabase CLI's:
postgres://postgres:postgres@host.docker.internal:54322/postgres), or remove DATABASE_URL
(from .env, or \`unset DATABASE_URL\` in this shell) to use the local container."
      ;;
    *.pooler.supabase.com)
      case "$address" in
        *:6543) kind="Supabase transaction pooler" ;;
        *) kind="Supabase session pooler" ;;
      esac
      ;;
    *.supabase.co | *.supabase.com) kind="Supabase" ;;
    *) kind="Postgres" ;;
  esac
  if [ -n "${DATABASE_URL+set}" ]; then
    echo "Database: $kind at $address (DATABASE_URL from this shell, which wins over .env)."
    # A DATABASE_URL left over in the shell (another project's, say) is easy to miss. The
    # migrations refuse a database holding another app's objects, but ask anyway when we can.
    if [ -t 0 ]; then
      printf '%s' "          The migrations and the Supabase hardening will run against it. Continue? [y/N] "
      read -r answer || answer=
      case "$answer" in
        y | Y | yes | YES) ;;
        *) fail "Stopped. Run \`unset DATABASE_URL\` to use .env (or the local container) instead." ;;
      esac
    fi
  else
    echo "Database: $kind at $address (DATABASE_URL from .env)."
  fi
  case "$host" in
    db.*.supabase.co)
      echo "          Note: the direct db.<ref>.supabase.co host is IPv6-only unless the project has the IPv4"
      echo "          add-on, and Docker networks usually have no IPv6. If it does not connect, use the Session"
      echo "          pooler connection string instead (docs/supabase.md)."
      ;;
  esac
  local_db=0
fi

# Compose passes DATABASE_CA_CERT into the container as text, so a file path on this computer
# (e.g. DATABASE_CA_CERT=./prod-ca-2021.crt) is read here.
ca_cert=$(setting DATABASE_CA_CERT)
case "$ca_cert" in
  "" | *-----BEGIN*) ;;
  *)
    [ -r "$ca_cert" ] || fail "DATABASE_CA_CERT names a file that cannot be read here: $ca_cert"
    DATABASE_CA_CERT=$(cat "$ca_cert")
    export DATABASE_CA_CERT
    echo "          Verifying the server against the CA certificate in $ca_cert."
    ;;
esac

cat <<'MSG'

  App:          http://localhost:3000
  Dev mailbox:  http://localhost:3000/api/dev/mailbox   (sign-in links and codes; nothing is emailed)
  Admin:        sign up as admin@example.com, or set ADMIN_EMAILS in .env
  Stop:         Ctrl+C (or `docker compose down`; add -v to delete all local data)

MSG

if [ "$local_db" -eq 1 ]; then
  exec docker compose up --build "$@"
fi
# A hosted database: no need to start (or download) the local one.
exec docker compose up --build --no-deps "$@" app
