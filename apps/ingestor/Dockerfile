# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/ingestor/package.json apps/ingestor/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter ingestor... --frozen-lockfile=false

FROM base AS builder
COPY --from=deps /repo /repo
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ingestor apps/ingestor
RUN pnpm --filter ingestor build
# Materialize a self-contained deploy folder (vendors deps, flattens symlinks).
RUN pnpm --filter ingestor deploy --prod /deploy

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S ingestor -u 1001

COPY --from=builder /deploy /app

USER ingestor
CMD ["node", "dist/index.js"]
