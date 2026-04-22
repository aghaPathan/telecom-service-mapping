# CLAUDE.md — Telecom Service Mapping

> Project north star for Claude Code sessions. Read before any non-trivial change.
> Global rules in `~/.claude/CLAUDE.md` still apply; this file adds project-specific constraints.

---

## Purpose (one line)

Docker-composed internal web app that ingests LLDP adjacency data nightly from a source Postgres, models it in Neo4j with a configurable telecom hierarchy, and lets operators path-trace customers to the core, view blast-radius, and save named queries.

---

## Quick Start

```bash
pnpm install
pnpm --filter @tsm/db build      # build shared workspace package first
pnpm -r typecheck                # tsc --noEmit across workspace
pnpm --filter ingestor test      # vitest + testcontainers (needs Docker)
pnpm --filter web test:e2e       # Playwright against PLAYWRIGHT_BASE_URL
```

### Compose stack

```bash
cp .env.example .env             # fill in secrets — never commit
docker compose build
docker compose up -d --wait      # Caddy on :80, other services internal
docker compose logs -f ingestor  # watch nightly cron ticks
```

### Ingestor CLI (`pnpm --filter ingestor dev` locally, or `node dist/index.js` in the container)

- `--dry-run` — run source → dedup → resolver, skip Neo4j write, record run row
- `--once`    — run once and exit (no cron). Implied by `--dry-run`.
- no flag     — long-lived `node-cron` scheduler (skipped when `INGEST_MODE=smoke`, which runs a one-shot seed and exits)

---

## Data sensitivity — **read first**

The source database contains **real operator production data** (Mobily / Saudi operator context: `mobily_cid`, real hostnames, customer circuit IDs).

**Hard rules:**

- **Never** read, echo, log, or commit the contents of `.env` or anything read from `DATABASE_URL_SOURCE`.
- **Never** paste real hostnames, customer IDs, CIDs, IPs, or MACs into issue descriptions, commit messages, or external tools (chat, pastebins, diagram renderers, web search).
- Any screenshot, demo, or export leaving the home-server LAN requires prior redaction. Replace site codes and role prefixes with preserved-shape placeholders (e.g. `PK-KHI-CORE-01` → `XX-YYY-CORE-01`).
- Source DB access must be via a read-only role (`lldp_readonly` with `default_transaction_read_only=on`). Never grant write.
- Secrets flow: `.env` (gitignored) → `docker-compose env_file` → `process.env.*`. Never inline.

When in doubt, redact or ask.

---

## Architecture at a glance

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

Five compose services: `caddy`, `web`, `postgres`, `neo4j`, `ingestor`. Web is never exposed directly; Caddy fronts everything.

---

## Canonical decisions (changing these requires an ADR)

| Area | Decision |
|---|---|
| Ingest cadence | Nightly full-refresh (not incremental); staleness window accepted for MVP |
| Ingest host | Dedicated `ingestor` service (not inside Next.js runtime) |
| Dedup | Canonical unordered `{(device, interface)}` pair; merge both-direction rows; drop self-loops and NULL `device_b_name`; anomaly → keep latest `updated_at` |
| Hierarchy | `config/hierarchy.yaml` (configurable) — Core → Aggregation → CustomerAggregation → Transport (L3.5) → Access → Customer |
| Role resolution | `config/role_codes.yaml` (configurable) — priority: `type_column` → name prefix → `Unknown` |
| SW leveling | Dynamic post-ingest Cypher pass, based on topology |
| Auth | **Custom session layer** (not Auth.js at runtime) + bcrypt(cost=12) + DB-backed sessions (revocable via `DELETE FROM sessions` or `is_active=false`). See [ADR 0001](docs/decisions/0001-auth-stack.md) for why we pivoted away from Auth.js v5 beta's Credentials provider. |
| RBAC | Three roles: `admin` / `operator` / `viewer`. No domain/region filtering in MVP. |
| Provisioning | Admin-only via `npm run create-admin` CLI — **no self-signup** |
| TLS | Caddy reverse-proxy with auto-TLS. Cookie flags (`Secure`, `__Secure-` prefix) derive from `NEXTAUTH_URL` scheme — HTTP deployments (CI, internal-LAN) drop both so browsers don't reject. |
| Path direction | `:CONNECTS_TO` stored direction is canonical (lesser→greater); treat as undirected when matching; "downstream" derived from `level`, not stored direction |

---

## Configurable behavior (edit without redeploying code)

- `config/hierarchy.yaml` — level definitions, SW dynamic-leveling toggle, Unknown label
- `config/role_codes.yaml` — role-code → canonical role mappings, fallback, resolver priority

Both files are loaded fresh at the start of every ingest run. No code change or container rebuild is needed to adjust them — just edit and trigger a re-ingest.

---

## Neo4j model (reference)

```cypher
(:Device {name, vendor, domain, site, role, level, ip, mac})
  // + secondary label per role: :Core :UPE :CSG :MW :Ran :GPON :SW :PTP :PMP :Customer :Unknown
(:Site    {name, category, url})
(:Service {cid, mobily_cid, bandwidth, protection_type, region})

(:Device)-[:CONNECTS_TO {a_if, b_if, trunk, updated_at}]-(:Device)  // undirected in semantics
(:Device)-[:LOCATED_AT]->(:Site)
(:Service)-[:TERMINATES_AT {role: 'source'|'dest'}]->(:Device)
(:Service)-[:PROTECTED_BY]->(:Service)
```

Constraints / indexes: unique `Device(name)`, unique `Site(name)`, unique `Service(cid)`; fulltext `Device(name)`; btree `Device(role)`, `Device(domain)`, `Device(site)`, `Service(mobily_cid)`.

---

## Source schema — fields we rely on

`app_lldp` (689k rows, ~221k active):

- Pair: `device_a_name`, `device_a_interface`, `device_a_trunk_name`, `device_a_ip`, `device_a_mac`, `device_b_name`, `device_b_interface`, `device_b_ip`, `device_b_mac`
- Classification: `type_a`, `type_b`, `vendor_a`, `vendor_b`, `domain_a`, `domain_b`
- Lifecycle: `status` (boolean), `load_dt`, `created_at`, `updated_at`, `data_source`
- **Triggers of interest**: `on_insert_deactivate_old_records` (explains `status=true` filter), `on_insert_lldp_data` (populates `app_devicecid`)

`app_cid` — customer circuit master (`cid`, `source`, `dest`, `bandwidth`, `protection_type`, `protection_cid`, `mobily_cid`, `region`).
`app_devicecid` — `(cid, device_a_name, device_b_name)` mapping of circuits to device endpoints.
`app_sitesportal` — `(site_name, category, site_url)`.

Other `app_*` tables (`alarms`, `isolations`, `techbuilding`, `span`, `screenportal`) are **out of scope for MVP**.

---

## Project layout (intended)

```
.
├── apps/
│   ├── web/           # Next.js 14 (App Router) + Tailwind + Auth.js v5
│   └── ingestor/      # Node + node-cron + Neo4j driver + pg
├── packages/
│   └── db/            # node-pg-migrate .sql migrations + shared pg Pool helper
│                      # (packages/config and packages/graph are not yet
│                      # extracted — shared code currently lives in
│                      # apps/ingestor/src; split when the web app needs it)
├── config/
│   ├── hierarchy.yaml
│   └── role_codes.yaml
├── caddy/
│   └── Caddyfile
├── docker-compose.yml
├── .env.example
└── docs/
    └── decisions/     # ADRs when canonical decisions change
```

Monorepo managed with `pnpm` workspaces (unless a strong reason emerges to diverge).

---

## Development workflow

- **Never commit to `main`.** Feature branch per issue; PR with spec compliance + quality review.
- **TDD** for ingestor logic: dedup, role resolver, hierarchy resolver, SW dynamic-pass — write failing test first.
- **Integration tests use testcontainers** (real Postgres 13 + Neo4j 5). **No mocks of the DB** — per global feedback-memory rule.
- **Fixtures**: 50-row synthetic fixture kept in `apps/ingestor/test/fixtures/` — never copy real production rows into fixtures.
- **`--dry-run` flag** on the ingestor CLI is mandatory before any schema-touching change lands.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Bug fixes carry `root cause: <desc>` + a linked failing test.

---

## Tools & skills (project-specific routing)

- **Code navigation**: Serena MCP (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`). Shared-module edit protocol applies.
- **Cross-domain features**: `orchestration-pipeline` (security + backend + frontend + infra).
- **Single-domain multi-step**: `orchestration-pipeline-light`.
- **Implementing queued issues**: `issues-to-complete`. Completed: #2–#7. Next unblocked: **#8** (omnibox search) and **#11** (Caddy TLS). #9/#10/#12 chained behind #8.
- **Any Cypher change** → run it against a fresh testcontainer Neo4j first.

---

## Common pitfalls (future-Claude, don't repeat these)

- **Don't parse `app_lldp` rows as if each row is a link.** 90% are one-directional; 10% are mirrored. Dedup via canonical pair.
- **Don't infer direction from `device_a` vs `device_b`.** Use `level` from hierarchy.
- **Don't filter `status` away.** `status=true` means "currently observed"; false means "deactivated by trigger on later poll".
- **Don't treat blank `type_*` as an error.** 33% of rows are blank; fall back to name-prefix resolver → `Unknown`.
- **Don't expose Neo4j or web ports to the host.** Only Caddy publishes.
- **Don't use JWT sessions.** Sessions are DB-backed so admins can revoke.
- **Don't add interface nodes** (`:Interface`) in MVP — interface is an edge property.
- **Don't trust the source DB's unique constraint alone.** It includes IP + MAC; a stale IP rotation produces duplicate logical links. Handle in ingestor.
- **Don't treat `ingestion_runs.skipped=true` as a failure.** It's a benign row written when the cron fires while a prior run is still `status='running'`. The freshness badge and history page intentionally filter skipped rows out of "last real refresh".
- **Don't reintroduce Auth.js at runtime.** v5 beta's Credentials provider refuses `strategy: "database"` with `UnsupportedStrategy`, which blocks the revocation criterion. ADR 0001 documents the custom session layer (`apps/web/lib/session.ts`, `lib/session-cookie.ts`, `lib/authenticate.ts`) that replaces it. The `sessions` / `verification_token` / `accounts` tables stay in the migration (adapter-shaped) but are exercised only by our own code.
- **Don't key cookie flags off `NODE_ENV`.** CI and internal-LAN deployments run `NODE_ENV=production` behind HTTP-only Caddy; `Secure` / `__Secure-` cookies are silently dropped over HTTP. All three cookie sites (`lib/session-cookie.ts`, `middleware.ts`, `app/_components/logout-button.tsx`) must key off `NEXTAUTH_URL` scheme instead.
- **Don't remove `docker-compose.ci.yml` or the `--ignore-scripts` flag in `apps/web/Dockerfile`.** The CI overlay exposes `postgres:5432` on host so Playwright can seed E2E users from outside the compose network (production compose never includes it). `--ignore-scripts` skips `testcontainers → ssh2 → cpu-features` native builds that would fail in `node:20-alpine` with no python/compiler; those packages have pure-JS fallbacks.
- **Don't filter MW in the traversal WHERE — filter it in the projection.** Downstream queries (`runDownstream` in `apps/web/lib/downstream.ts`) must traverse THROUGH `:MW` (level 3.5) to reach the RAN/Customer devices behind it; exclusion happens post-collection (`WHERE $include_transport OR dst.level <> 3.5`) unless the caller opts in.

---

## Environment variables (see `.env.example` for the full list)

| Var | Purpose |
|---|---|
| `DATABASE_URL_SOURCE` | Read-only conn string to the source Postgres (LLDP data) |
| `DATABASE_URL` | App Postgres (users, sessions, saved_views) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j connection |
| `NEXTAUTH_URL` | Base URL — session cookie name + `Secure` flag derive from its scheme (http → plain `authjs.session-token`, https → `__Secure-authjs.session-token`). `NEXTAUTH_SECRET` / `AUTH_TRUST_HOST` are legacy placeholders from the Auth.js attempt; no runtime code reads them. |
| `INGEST_CRON` | Cron expression for nightly ingest (default `0 2 * * *`) |
| `INGEST_MODE` | `full` (default — real source + cron) \| `smoke` (CI tracer: one-shot seed of a single `:Device {name:'seed-01'}`, then exit) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | App Postgres container bootstrap |
| `CADDY_DOMAIN` | Hostname Caddy serves (e.g. `localhost` in CI) |
| `CADDY_TLS_MODE` | `internal` \| `tailscale` \| `acme` |

---

## Planning artifacts

- **Parent PRD**: GitHub issue [#1](https://github.com/aghaPathan/telecom-service-mapping/issues/1)
- **Slice issues**: [#2–#12](https://github.com/aghaPathan/telecom-service-mapping/issues) — tracer-bullet first, then feature widening
- **ADRs**: `docs/decisions/` (created on first deviation from canonical decisions)
