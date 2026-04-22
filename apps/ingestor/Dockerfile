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
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=deps /repo/apps/ingestor/node_modules /repo/apps/ingestor/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ingestor apps/ingestor
WORKDIR /repo/apps/ingestor
RUN pnpm build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S ingestor -u 1001

COPY --from=builder /repo/apps/ingestor/dist ./dist
COPY --from=builder /repo/apps/ingestor/node_modules ./node_modules
COPY --from=builder /repo/apps/ingestor/package.json ./package.json

USER ingestor
CMD ["node", "dist/index.js"]
