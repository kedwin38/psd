# Build from the repository root: docker build -f apps/web/Dockerfile .
# --build-arg VITE_API_URL=https://api.example.com/api/v1

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/scene-graph/package.json packages/scene-graph/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/scene-graph packages/scene-graph
COPY apps/web apps/web
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @psd-studio/scene-graph run build \
  && pnpm --filter @psd-studio/web exec vite build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
