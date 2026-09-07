# Docker Hub OCI index digest for node:20-bookworm-slim, resolved 2026-09-07.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.drill.json ./
RUN npm ci
COPY packages ./packages
COPY src ./src
COPY scripts/warm-embeddings.ts ./scripts/warm-embeddings.ts
COPY scripts/killswitch-drill.ts ./scripts/killswitch-drill.ts
COPY sources.yaml ./sources.yaml
ENV JEB_MODEL_CACHE=/app/.cache/jeb-models
ENV JEB_EMBED_DTYPE=q8
ENV JEB_MODEL_LOCAL_ONLY=0
RUN npm run build \
  && npm run build:drill \
  && npx tsx scripts/warm-embeddings.ts \
  && npm prune --omit=dev

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /app jeb \
  && mkdir -p /app/.cache/jeb-models \
  && chown -R jeb:jeb /app
USER jeb
COPY --from=build --chown=jeb:jeb /app/node_modules ./node_modules
COPY --from=build --chown=jeb:jeb /app/dist ./dist
COPY --from=build --chown=jeb:jeb /app/package.json ./
COPY --from=build --chown=jeb:jeb /app/sources.yaml ./sources.yaml
COPY --from=build --chown=jeb:jeb /app/.cache/jeb-models /app/.cache/jeb-models
ENV NODE_ENV=production
ENV JEB_MODEL_CACHE=/app/.cache/jeb-models
ENV JEB_EMBED_DTYPE=q8
ENV JEB_MODEL_LOCAL_ONLY=1

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS pubchi
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /app jeb \
  && mkdir -p /app/.cache/jeb-models \
  && chown -R jeb:jeb /app
USER jeb
COPY --from=build --chown=jeb:jeb /app/node_modules ./node_modules
COPY --from=build --chown=jeb:jeb /app/dist ./dist
COPY --from=build --chown=jeb:jeb /app/package.json ./
ENV NODE_ENV=production
ENV JEB_MODEL_LOCAL_ONLY=1
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "pubchi"]

FROM runtime AS jeb
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "all"]
