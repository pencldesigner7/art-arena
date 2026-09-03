# Art Arena — app container for Render (free tier)
#
# Postgres lives on NEON (external, persistent). The app container is
# intentionally stateless; the embedded dump below makes first boot
# self-healing: if the Neon database is empty, the entrypoint loads it.
FROM node:20-slim

# psql is only used by the entrypoint to load the embedded dump on first boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# deps first (layer cache)
COPY server/package*.json ./
RUN npm install --omit=dev

# app code + embedded DB dump (safety net) + entrypoint
COPY server/ ./
COPY backups/latest.sql /app/backups/latest.sql
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=development
# Render injects its own PORT (default 10000); the app reads process.env.PORT.
EXPOSE 10000
CMD ["/entrypoint.sh"]
