# Art Arena — app container for Render (free tier)
#
# Postgres lives on NEON (external, persistent). The app container is
# intentionally stateless. First boot is self-healing WITHOUT any database
# dump: if the Neon database is empty, the entrypoint creates the schema
# from the embedded server/schema.sql (pure DDL + static platform rows —
# no user data), and the app itself seeds the 10k+ randomizer word pool
# from server/randomizer_seed.json on startup.
FROM node:20-slim

# psql is only used by the entrypoint to create the schema on first boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# deps first (layer cache)
COPY server/package*.json ./
RUN npm install --omit=dev

# app code + first-boot schema bootstrap (server/schema.sql) + entrypoint
COPY server/ ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=development
# Render injects its own PORT (default 10000); the app reads process.env.PORT.
EXPOSE 10000
CMD ["/entrypoint.sh"]
