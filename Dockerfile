# syntax=docker/dockerfile:1

# GatePass container image. Multi-arch: node:22-bookworm-slim publishes
# linux/amd64 and linux/arm64 (Oracle Cloud Ampere A1) variants.

# ---------------------------------------------------------------- build
# The client bundle and the bundled server (dist/server/index.js) are
# platform-independent JavaScript, so this stage runs on the builder's native
# platform even when cross-building for another arch.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY . .
# Commit the image is built from (docker build --build-arg GATEPASS_COMMIT=$(git rev-parse HEAD)).
# .git is not in the build context, so this is the only source for
# dist/client/version.json here; empty means "unknown" (null).
ARG GATEPASS_COMMIT=""
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
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

# Short interval so orchestrators (compose depends_on, CI) see a restart or a
# hung process within about 30 s instead of minutes.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Reported by /api/health as build.commit. Declared last so a new commit does
# not invalidate the dependency layers above. When empty, the server falls back
# to RENDER_GIT_COMMIT, which Render sets at runtime.
ARG GATEPASS_COMMIT=""
ENV GATEPASS_COMMIT=${GATEPASS_COMMIT}

CMD ["node", "dist/server/index.js"]
