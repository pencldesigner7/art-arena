#!/bin/bash
# ============================================================================
# Art Arena on Render — container entrypoint
# First boot: if the Neon database is empty, load the embedded full dump,
# then start the app. On every later boot the existing data is kept.
# ============================================================================
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERROR: DATABASE_URL is not set (the Neon connection string)."
  echo "[entrypoint] Add it in Render: service → Environment → DATABASE_URL."
  exit 1
fi

# Neon free compute may need a few seconds to wake up on first contact.
N=""
for i in $(seq 1 10); do
  N=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '[:space:]') && [ -n "$N" ] && break
  echo "[entrypoint] waiting for database (attempt $i/10)..."
  sleep 3
done
if [ -z "$N" ]; then
  echo "[entrypoint] ERROR: could not reach the database via DATABASE_URL."
  exit 1
fi

if [ "$N" = "0" ]; then
  echo "[entrypoint] first boot: loading embedded dump into Neon..."
  # strip pg_dump-17-only guard lines so psql accepts the file
  grep -vE '^\\(restrict|unrestrict)' /app/backups/latest.sql \
    | psql "$DATABASE_URL" -q -v ON_ERROR_STOP=0 2>&1 | grep -E 'ERROR|FATAL' | head -10 || true
  N=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -d '[:space:]')
  echo "[entrypoint] public tables: $N"
  echo "[entrypoint] users: $(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo '?')"
else
  echo "[entrypoint] database has $N public tables — keeping existing data"
fi

echo "[entrypoint] starting Art Arena on port ${PORT:-10000}..."
exec node server.js
