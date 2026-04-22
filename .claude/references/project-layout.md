# Project layout (reference — read when adding new files)

```
.
├── apps/
│   ├── web/           # Next.js 14 (App Router) + Tailwind + custom session layer
│   └── ingestor/      # Node + node-cron + Neo4j driver + pg
├── packages/
│   └── db/            # node-pg-migrate .sql migrations + shared pg Pool helper
│                      # (packages/config and packages/graph are not yet extracted —
│                      #  shared code currently lives in apps/ingestor/src; split
│                      #  when the web app needs it)
├── config/
│   ├── hierarchy.yaml
│   └── role_codes.yaml
├── caddy/
│   └── Caddyfile
├── docker-compose.yml
├── docker-compose.ci.yml   # CI-only — exposes pg + neo4j on localhost for Playwright
├── .env.example
├── .claude/
│   └── references/    # on-demand context for Claude Code sessions
└── docs/
    ├── plans/         # per-issue implementation plans (dated)
    └── decisions/     # ADRs when canonical decisions change
```

Monorepo managed with `pnpm` workspaces (unless a strong reason emerges to diverge).

## Notable within-app locations

- `apps/web/lib/` — resolvers + shared helpers (`neo4j.ts`, `postgres.ts`, `session.ts`, `rbac.ts`, `rate-limit.ts`, `csv.ts`, `path.ts`, `downstream.ts`, `search.ts`).
- `apps/web/app/_components/` — shared UI (`role-badge.tsx`, `path-view.tsx`, `omnibox.tsx`, `freshness-badge.tsx`, `logout-button.tsx`).
- `apps/web/app/api/` — route handlers (`search`, `path`, `downstream`, `downstream/csv`, `health`, `ingestion/run`, `ingestion/status`).
- `apps/web/test/*.test.ts` — unit (vitest, `.test.{ts,tsx}`). `.int.test.ts` are integration (testcontainers). `apps/web/e2e/*.spec.ts` are Playwright.
- `apps/ingestor/src/` — `cron.ts`, `dedup.ts`, `resolver.ts`, `services.ts`, `site.ts`, `runs.ts`, `source/*`, `graph/writer.ts`.
