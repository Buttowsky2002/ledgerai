# BadgerIQ dashboard — rebuild after UI changes:
#   docker compose up -d --build dashboard
#
# Layout mirrors the monorepo so file:../../packages/shared-types resolves during npm ci.

FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# shared-types (local dependency of the dashboard)
COPY packages/shared-types/package.json packages/shared-types/package-lock.json packages/shared-types/
COPY packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/shared-types/src packages/shared-types/src
WORKDIR /repo/packages/shared-types
RUN npm ci && npm run build

# dashboard — paths must match package.json "file:../../packages/shared-types"
COPY apps/dashboard/package.json apps/dashboard/package-lock.json /repo/apps/dashboard/
WORKDIR /repo/apps/dashboard
RUN test -f package-lock.json && npm ci

COPY apps/dashboard /repo/apps/dashboard
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
ARG BADGERIQ_API_URL=http://api:8094
ENV BADGERIQ_API_URL=$BADGERIQ_API_URL
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/dashboard/public ./public
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
