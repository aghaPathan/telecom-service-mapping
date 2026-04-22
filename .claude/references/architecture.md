# Architecture (reference — read when designing/debugging cross-service flows)

## Service topology

```
┌──────────────┐   read-only    ┌────────────┐    full-refresh   ┌────────────┐
│ Source       │ ◀────────────  │  Ingestor  │ ────────────────▶ │   Neo4j    │
│ Postgres     │  (nightly)     │ node-cron  │                   │ 5-community│
│ (app_lldp,   │                │            │                   │            │
│  app_cid,    │                │            │                   │            │
│  app_device- │                └─────┬──────┘                   └──────┬─────┘
│  cid,        │                      │ run metadata                    │ cypher
│  app_sites-  │                      ▼                                 │
│  portal)     │                ┌────────────┐      next.js       ┌─────▼─────┐
└──────────────┘                │  Postgres  │    server actions  │    Web    │
                                │  13 (app)  │ ◀──────────────────│  Next.js  │
                                │  users,    │                    │  + custom │
                                │  sessions, │                    │  session  │
                                │  saved_    │                    │  + Tailwind│
                                │  views,    │                    └──────┬────┘
                                │  audit_log,│                           │
                                │  ingestion_│                           │
                                │  runs      │                    ┌──────▼────┐
                                └────────────┘                    │   Caddy   │
                                                                  │ reverse   │
                                                                  │ proxy+TLS │
                                                                  └───────────┘
```

## Compose services

Five services: `caddy`, `web`, `postgres`, `neo4j`, `ingestor`.

- **`caddy`** — only service that publishes to the host. Auto-TLS (internal / Tailscale / ACME).
- **`web`** — Next.js 14 App Router + Tailwind + custom session layer. Never exposed directly.
- **`postgres`** — Postgres 13. App state (users, sessions, saved_views, audit_log, ingestion_runs).
- **`neo4j`** — Neo4j 5 community. Graph model (Device/Site/Service + edges).
- **`ingestor`** — Node + node-cron. Reads source Postgres read-only, full-refreshes Neo4j nightly. `INGEST_MODE=smoke` is the CI one-shot seed.

## CI overlay (`docker-compose.ci.yml`)

CI-only file that exposes `postgres:5432` **and** `neo4j:7687` on `127.0.0.1` so GitHub-Actions-hosted Playwright (running outside the compose network) can seed E2E fixtures. Production compose never includes this overlay.

## Request flow

1. User → Caddy (`:80`/`:443`) → `web` container
2. Auth middleware (`apps/web/middleware.ts`) checks the session cookie; missing → redirect to `/login?next=...`.
3. Server components call resolvers in `apps/web/lib/*` directly (neo4j driver + pg pool singletons).
4. API routes (`apps/web/app/api/*`) apply `requireRole(...)` then the same resolver calls.
5. `ingestor` runs independently — never in-band with the web request cycle.
