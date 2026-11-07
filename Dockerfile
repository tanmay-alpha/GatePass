# syntax=docker/dockerfile:1

# GatePass container image. Multi-arch: node:22-bookworm-slim publishes
# linux/amd64 and linux/arm64 (Oracle Cloud Ampere A1) variants.

# ---------------------------------------------------------------- build
# The client bundle and the bundled server (dist/server/index.js) are
# platform-independent JavaScript, so this stage runs on the builder's native
# platform even when cross-building for another arch.
FROM --platform=$BUILDPLATFORM node:25-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:25-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_FILE=/data/gatepass.db \
    CLIENT_DIR=/app/dist/client \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Production dependencies only (express, helmet, express-rate-limit, qrcode,
# zod). The server bundle keeps them external.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# Prebuilt output only: no TypeScript sources and no runtime transpiler.
COPY LICENSE NOTICE ./
COPY --from=build /app/dist ./dist

# SQLite database, -wal and -shm files live here. A fresh named volume inherits
# this ownership, so the non-root user can write to it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/index.js"]
