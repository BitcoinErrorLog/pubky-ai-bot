FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
RUN useradd --system --uid 10001 --home /app jeb && chown -R jeb:jeb /app
USER jeb
COPY --from=build --chown=jeb:jeb /app/node_modules ./node_modules
COPY --from=build --chown=jeb:jeb /app/dist ./dist
COPY --from=build --chown=jeb:jeb /app/package.json ./
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "all"]
