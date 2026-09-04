# Runtime/base image is node:20-bookworm-slim. Digest pin is optional and not applied
# (audit F-15 / slim F-13): retag the digest in a fork if you need reproducible pulls.
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.drill.json ./
RUN npm ci
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

FROM node:20-bookworm-slim
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
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "all"]
