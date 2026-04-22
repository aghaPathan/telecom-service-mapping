# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter web... --frozen-lockfile=false

FROM base AS builder
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=deps /repo/apps/web/node_modules /repo/apps/web/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web apps/web
WORKDIR /repo/apps/web
RUN pnpm build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
