# Build from the repository root: docker build -f apps/api/Dockerfile .
# Produces one image used for both the API and the worker process — the
# worker service just overrides CMD (see docker-compose.yml).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# --- deps: install the whole workspace (cached separately from source) ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
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
  && cp -r apps/api/src/generated apps/api/dist/generated \
  && cp -r apps/api/models apps/api/dist/models

# Fetch the BiRefNet-portrait fp16 matting model (~490MB, sha256-pinned) into apps/api/.models —
# too large to vendor in git (GitHub's 100MB per-file limit), so the image build downloads and
# verifies it. The runtime stage copies it in explicitly; matting.ts resolves it relative to
# dist/id-photo (-> /app/.models).
RUN pnpm --filter @psd-studio/api run fetch-models

# --- deploy: resolve a self-contained, production-only package directory ---
FROM build AS deploy
RUN pnpm --filter @psd-studio/api deploy --prod --legacy /deploy

# --- runtime: small final image ---
FROM node:22-slim AS runtime
# Prisma's query engine needs libssl at runtime on Debian. The slim base ships no fonts, and
# @napi-rs/canvas draws no text at all without one, so exports would silently lose every text layer.
RUN apt-get update && apt-get install -y --no-install-recommends openssl fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy /deploy .
COPY --from=build /repo/apps/api/.models /app/.models
RUN mkdir -p storage-data
# No EXPOSE: platform routing comes from the deploy spec's http_port/internal_ports, and an
# EXPOSEd port makes some platforms (DigitalOcean App Platform) probe it with a TCP readiness
# check — which a queue worker that never listens would always fail.
CMD ["node", "dist/main.js"]
