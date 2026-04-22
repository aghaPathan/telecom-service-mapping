# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
# @tsm/db is a web devDep (used only by integration tests), but pnpm's
# workspace resolver still needs its package.json present to validate the
# lockfile — otherwise `deploy --prod` fails ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
COPY packages/db/package.json packages/db/package.json
# --ignore-scripts: web devDeps (testcontainers → ssh2 → cpu-features) try to
# invoke node-gyp at install time. Alpine has no python/compiler, and these
# native bindings are never needed for the production image. Skipping install
# scripts keeps Alpine lean while leaving pure-JS fallbacks intact.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter web... --frozen-lockfile=false --ignore-scripts

FROM base AS builder
COPY --from=deps /repo /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/db packages/db
RUN pnpm --filter web build
# Materialize a flat, prod-only app folder (vendors dependencies, resolves symlinks).
RUN pnpm --filter web deploy --prod --ignore-scripts /deploy

FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /deploy /app
COPY --from=builder /repo/apps/web/.next /app/.next
COPY --from=builder /repo/apps/web/public /app/public

USER nextjs
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]
