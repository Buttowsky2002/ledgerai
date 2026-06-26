# Control-plane API (NestJS + Prisma). Build on glibc so the Prisma engine
# matches the distroless debian runtime (musl/glibc mismatch otherwise crashes
# the query engine at startup).
FROM node:20-slim AS build
WORKDIR /src
# OpenSSL is needed for `prisma generate` to pick the right engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci
COPY services/api/ ./
COPY pricing/pricebook.json ./pricing/pricebook.json
RUN npm run prisma:generate && npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/prisma ./prisma
COPY --from=build /src/pricing ./pricing
EXPOSE 8094
# distroless/nodejs entrypoint is `node`; pass the bundled entry.
CMD ["dist/main.js"]
