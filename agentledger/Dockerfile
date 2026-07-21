# =============================================================================
# BadgerIQ control-plane API — production image for Google Cloud Run
# =============================================================================
#
# Stack (as found in this repo — NOT Go + Vite):
#   - Backend:  NestJS (Node 20 + TypeScript) with Prisma on Postgres and
#     ClickHouse for analytics. Source: services/api/
#   - Frontend: Next.js server app in apps/dashboard/ — it has server-side BFF
#     routes, so it CANNOT be served as static files from this container.
#     Deploy it as its own Cloud Run service using Dockerfile.dashboard.
#
# Cloud Run contract satisfied by this image:
#   - Listens on $PORT (the app reads PORT when BADGERIQ_API_ADDR is unset)
#   - Single process (node), no process manager
#   - Graceful shutdown: NestJS enableShutdownHooks() handles SIGTERM, and the
#     exec-form CMD ensures node is PID 1 and receives the signal directly
#   - Non-root: distroless :nonroot runs as uid 65532
#   - Health endpoints served by the app: /health (/healthz), /ready (/readyz),
#     /version
#
# Build from the repo root (the context must include pricing/):
#   docker build -t us-central1-docker.pkg.dev/badgeriq-prod/badgeriq/badgeriq-api:latest \
#     --build-arg BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg BUILD_SHA=$(git rev-parse HEAD) .
#
# No secrets are baked into this image. All configuration arrives at runtime
# via Cloud Run --set-env-vars / --set-secrets (see README of services/api).

# -----------------------------------------------------------------------------
# Stage 1 — build: compile TypeScript, generate the Prisma client, then strip
# dev dependencies. node:20-slim (glibc) is required: the Prisma query engine
# built here must match the distroless Debian runtime (a musl/alpine build
# crashes at startup).
# -----------------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /src

# OpenSSL + CA certs are needed for `prisma generate` to select the right engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first so this layer is cached until the lockfile changes.
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci

# Now the source. The price book lives at the repo root and is read at runtime.
COPY services/api/ ./
COPY pricing/pricebook.json ./pricing/pricebook.json

# prisma generate → nest build → copy report assets (postbuild) → drop dev deps.
RUN npm run prisma:generate && npm run build && npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2 — runtime: distroless Node (no shell, no package manager, non-root).
# Everything copied in is owned by root and read-only to the runtime user,
# which is what we want for an immutable container.
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12:nonroot

WORKDIR /app
ENV NODE_ENV=production

# Version stamping for GET /version — build metadata only, never secrets.
ARG BUILD_VERSION=dev
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BADGERIQ_BUILD_VERSION=$BUILD_VERSION \
    BADGERIQ_BUILD_SHA=$BUILD_SHA \
    BADGERIQ_BUILD_TIME=$BUILD_TIME

# Production node_modules (includes the generated Prisma client + engine).
COPY --from=build /src/node_modules ./node_modules
# Compiled app + runtime assets.
COPY --from=build /src/dist ./dist
COPY --from=build /src/assets ./assets
COPY --from=build /src/prisma ./prisma
COPY --from=build /src/pricing ./pricing

# Documentation only — Cloud Run routes to $PORT regardless of EXPOSE.
EXPOSE 8080

# distroless/nodejs entrypoint is `node`; exec form keeps it PID 1 so SIGTERM
# from Cloud Run reaches the app directly (graceful shutdown).
CMD ["dist/main.js"]
