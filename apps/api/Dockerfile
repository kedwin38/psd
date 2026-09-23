# Build from the repository root: docker build -f apps/api/Dockerfile .
# Produces one image used for both the API and the worker process — the
# worker service just overrides CMD (see docker-compose.yml).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# --- deps: install the whole workspace (cached separately from source) ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/scene-graph/package.json packages/scene-graph/package.json
COPY packages/psd-engine/package.json packages/psd-engine/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

# --- build: compile the shared packages and the API ---
FROM deps AS build
COPY packages/scene-graph packages/scene-graph
COPY packages/psd-engine packages/psd-engine
COPY apps/api apps/api
RUN pnpm --filter @psd-studio/scene-graph run build \
  && pnpm --filter @psd-studio/psd-engine run build \
  && pnpm --filter @psd-studio/api run prisma:generate \
  && pnpm --filter @psd-studio/api exec nest build \
  && cp -r apps/api/src/generated apps/api/dist/generated

# --- deploy: resolve a self-contained, production-only package directory ---
FROM build AS deploy
RUN pnpm --filter @psd-studio/api deploy --prod --legacy /deploy

# --- runtime: small final image ---
FROM node:22-slim AS runtime
# Prisma's query engine needs libssl at runtime on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy /deploy .
RUN mkdir -p storage-data
EXPOSE 3000
CMD ["node", "dist/main.js"]
