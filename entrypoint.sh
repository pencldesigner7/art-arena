#!/bin/bash
# ============================================================================
# Art Arena on Render — container entrypoint
# First boot: if the database is empty, create the schema from the embedded
# server/schema.sql (pure DDL + static platform rows — no user data). The
# app then seeds the randomizer word pool itself on startup. Every later
# boot keeps the existing data. (A full dump at /app/backups/latest.sql is
# still honored if one is mounted/built in, but none is required.)
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
  # Prefer a full dump if one was built in (backward compatible); otherwise
  # fall back to the schema-only bootstrap that ships with the app code.
  if [ -f /app/backups/latest.sql ]; then
    SEED=/app/backups/latest.sql
    echo "[entrypoint] first boot: loading embedded dump into the database..."
  elif [ -f /app/schema.sql ]; then
    SEED=/app/schema.sql
    echo "[entrypoint] first boot: creating schema from server/schema.sql (no dump needed)..."
  else
    echo "[entrypoint] ERROR: database is empty and no bootstrap file was found"
    echo "[entrypoint] (expected /app/schema.sql inside the image)."
    exit 1
  fi
  # strip pg_dump-17-only guard lines so psql accepts the file
  grep -vE '^\\(restrict|unrestrict)' "$SEED" \
    | psql "$DATABASE_URL" -q -v ON_ERROR_STOP=0 2>&1 | grep -E 'ERROR|FATAL' | head -10 || true
  N=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -d '[:space:]')
  echo "[entrypoint] public tables: $N"
  if [ "$N" = "0" ]; then
    echo "[entrypoint] ERROR: bootstrap loaded no tables — check the database credentials/permissions."
    exit 1
  fi
else
  echo "[entrypoint] database has $N public tables — keeping existing data"
fi

echo "[entrypoint] starting Art Arena on port ${PORT:-10000}..."
exec node server.js
