# Telecom Service Mapping

> Internal web application that turns nightly LLDP adjacency data into an interactive, hierarchy-aware connectivity graph — so operators can trace a customer to the core, see blast-radius downstream of any device, and save their investigations for reuse.

> **Status (as of this commit):** scaffolding only. The PRD (issue [#1](https://github.com/aghaPathan/telecom-service-mapping/issues/1)) and 11 implementation slices ([#2–#12](https://github.com/aghaPathan/telecom-service-mapping/issues)) are defined; no service code or compose stack has been committed yet. The sections below describe the **intended** architecture and developer experience. Commands that depend on services (Next.js, Neo4j, ingestor) only become executable once slices #2–#6 land.

---

## Table of contents

1. [What this is](#what-this-is)
2. [Why it exists](#why-it-exists)
3. [Features (MVP)](#features-mvp)
4. [Architecture](#architecture)
5. [Data model](#data-model)
6. [Quick start (local dev)](#quick-start-local-dev)
7. [Configuration](#configuration)
8. [Operations](#operations)
9. [Development](#development)
10. [Testing](#testing)
11. [Security & data sensitivity](#security--data-sensitivity)
12. [Roadmap](#roadmap)
13. [Project layout](#project-layout)
14. [Contributing](#contributing)

---

## What this is

A docker-composed stack (Next.js + Postgres 13 + Neo4j 5 + Caddy + an ingestor service) that:

1. Reads LLDP link data (plus circuit and site metadata) from a read-only source Postgres.
2. Deduplicates and normalizes ~221k active adjacencies into ~183k unique physical links.
3. Resolves each device's role (`Core`, `UPE`, `CSG`, `GPON`, `MW`, `Ran`, `SW`, `PTP`, `PMP`, `Business Customer`) and hierarchy level using configurable YAML.
4. Loads everything into Neo4j as a first-class graph.
5. Exposes a web UI for operators to search, path-trace, view blast-radius, and save views.

---

## Why it exists

LLDP tables are great for raw adjacency but terrible for answering operational questions like *"if this aggregation router goes down, which customers lose service?"* or *"what's the exact path from CID `M-2341` to the core?"*. Answering those from flat SQL requires recursive CTEs, manual role classification, and knowledge of the telecom hierarchy. This app bakes that knowledge in once, refreshes nightly, and makes every operator a power user.

---

## Features (MVP)

- **Daily full-refresh ingest** from source Postgres → Neo4j, with a row-count audit trail.
- **Omnibox search** resolving `cid` → `mobily_cid` → device name (fulltext) in priority order.
- **Path-trace**: from a customer service or device, show the upward path to the nearest `:Core` node with interfaces labeled.
- **Blast-radius / downstream view**: everything reachable downward from a device, grouped and aggregated by role.
- **Saved views**: per-user, with role-based sharing (operator → viewer, admin → any).
- **Role-based access control**: `admin` / `operator` / `viewer` with DB-backed revocable sessions.
- **Freshness badge** in the UI header: "Last refresh: Xh Ym ago · N devices · M links".
- **Auto-TLS** via Caddy for LAN, Tailscale, or public deployment.

Deferred to v2: SPOF detection, domain/region-based RBAC, zero-downtime staging-swap ingest, Prometheus metrics, geo visualization.

---

## Architecture

```
┌──────────────┐   SELECT-only   ┌────────────┐    full-refresh   ┌────────────┐
│  Source      │ ◀────────────── │  Ingestor  │ ────────────────▶ │   Neo4j    │
│  Postgres    │     nightly     │ node-cron  │                   │ 5 Community│
└──────────────┘                 └─────┬──────┘                   └──────┬─────┘
                                       │ writes ingestion_runs           │
                                       ▼                                 │ Cypher
                                ┌────────────┐      server actions ┌─────▼─────┐
                                │ App        │ ◀────────────────── │    Web    │
                                │ Postgres 13│                     │  Next.js  │
                                │ users,     │                     │  Auth.js  │
                                │ sessions,  │                     │  Tailwind │
                                │ saved_views│                     └─────┬─────┘
                                └────────────┘                           │ HTTPS
                                                                   ┌─────▼─────┐
                                                                   │   Caddy   │
                                                                   │ auto-TLS  │
                                                                   └───────────┘
```

**Why a separate ingestor service (not inside Next.js)?** Next.js workloads prefer stateless. A single-purpose Node + `node-cron` container survives web restarts, avoids duplicate runs on multi-replica web, and can be scheduled independently.

**Why Neo4j?** Path-trace, blast-radius, and shortest-path queries on a 50k-node / 180k-edge graph are native Cypher operations. Expressing them in SQL recursive CTEs would be correct but slow and unmaintainable.

**Why Postgres 13 alongside?** Keeps the graph pure. User accounts, sessions, audit log, saved views, and ingest run-history belong in a relational store with transactions and migrations.

---

## Data model

### Source tables (read-only)

| Table | Purpose |
|---|---|
| `app_lldp` | Device-to-device LLDP adjacencies (~689k rows, ~221k active) |
| `app_cid` | Customer circuits (source/dest devices, bandwidth, protection) |
| `app_devicecid` | Circuit ↔ device-pair mapping (populated by a source-side trigger) |
| `app_sitesportal` | Site metadata (name, category, URL) |

### Neo4j graph

```cypher
(:Device {name, vendor, domain, site, role, level, ip, mac})
  // secondary label per role: :Core :UPE :CSG :MW :Ran :GPON :SW :PTP :PMP :Customer :Unknown
(:Site    {name, category, url})
(:Service {cid, mobily_cid, bandwidth, protection_type, region})

(:Device)-[:CONNECTS_TO {a_if, b_if, trunk, updated_at}]-(:Device)
(:Device)-[:LOCATED_AT]->(:Site)
(:Service)-[:TERMINATES_AT {role}]->(:Device)
(:Service)-[:PROTECTED_BY]->(:Service)
```

**Edge semantics.** `:CONNECTS_TO` is semantically undirected. For storage, we always orient it from the canonical-lesser endpoint to the canonical-greater endpoint (lexicographic on `device_name`, then `interface`). Traversal code uses un-directional matching (`MATCH (a)-[:CONNECTS_TO]-(b)`) and derives "downstream" from node `level`, not edge direction.

**Dedup policy.** The source is asymmetric: ~90% of physical links are reported from one side only (unmanaged neighbors), ~10% from both. We key every link by the unordered pair `{(device_a, iface_a), (device_b, iface_b)}`, merge properties preferring non-null, drop self-loops, drop rows with NULL `device_b_name`, and for rare anomalies (>2 rows per pair) keep the row with the latest `updated_at`.

### App Postgres tables

- `users (id, email UNIQUE, password_hash, role, is_active, created_at, updated_at)`
- `sessions`, `verification_tokens` — Auth.js adapter tables
- `saved_views (id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at)`
- `audit_log (id, user_id, action, target, metadata_json, at)`
- `ingestion_runs (id, started_at, finished_at, status, source_rows_read, graph_nodes_written, graph_edges_written, rows_dropped_null_b, rows_dropped_anomaly, warnings_json, error_text)`

---

## Quick start (local dev)

> **Note:** steps 1 and the `docker compose` / `npm run` commands below describe the **intended** developer experience and become fully executable once slices [#2](https://github.com/aghaPathan/telecom-service-mapping/issues/2) (compose stack + tracer bullet) and [#6](https://github.com/aghaPathan/telecom-service-mapping/issues/6) (cron + observability) land. Until then, only the source-DB role SQL (step 1) and `cp .env.example .env` (step 2) work as written.

### Prerequisites

- Docker + docker-compose v2
- Node.js 20 + pnpm 9
- A read-only Postgres role on the source DB (see below)

### 1. Create the source-DB read-only role (once, on the source)

```sql
CREATE ROLE lldp_readonly LOGIN PASSWORD '<pick-one>';
ALTER ROLE lldp_readonly SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE <source_db> TO lldp_readonly;
GRANT USAGE ON SCHEMA public TO lldp_readonly;
GRANT SELECT ON app_lldp, app_cid, app_devicecid, app_sitesportal TO lldp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO lldp_readonly;
```

### 2. Copy and fill `.env`

```bash
cp .env.example .env
# edit .env — never commit this file
```

### 3. Bring up the stack

```bash
docker compose up -d --build
```

Five services start: `caddy`, `web`, `postgres`, `neo4j`, `ingestor`. Caddy publishes the only public port.

### 4. Seed an admin user

The app has **no self-signup** — the very first admin must be bootstrapped via
the `create-admin` CLI shipped in the `web` image.

```bash
docker compose exec -iT web npm run create-admin
```

The `-iT` flags keep stdin attached without allocating a pseudo-TTY (so the
prompt does not echo the password as you type). You will be prompted for:

```
Email:    you@example.com
Password: ********
Confirm:  ********
```

On success the CLI prints:

```
created admin you@example.com
```

After this, log in at `https://localhost` (or your configured host) with the
credentials you just set, then create additional users via `/admin/users`.

**Troubleshooting — wrong password on the first user.** If the bootstrap
admin was created with a typo'd password, re-run with `--force` to upsert:

```bash
docker compose exec -iT web npm run create-admin -- --force
```

`--force` updates the password hash for the existing email and reactivates the
account; without it the CLI refuses to overwrite an existing user.

### 5. Trigger the first ingest

```bash
docker compose run --rm ingestor node dist/index.js --dry-run   # verify counts first
docker compose run --rm ingestor node dist/index.js             # real run (full-refresh)
```

The ingestor:

- applies pending `@tsm/db` migrations on startup (creates `ingestion_runs` on first run),
- reads `app_lldp WHERE status = true` from `DATABASE_URL_SOURCE`,
- dedupes per the PRD canonical-pair policy (self-loops, NULL `device_b_name`, and
  >2-row anomalies are dropped; the rest are merged),
- full-refreshes `:Device` and `:CONNECTS_TO` in Neo4j (`DETACH DELETE` then batched
  `UNWIND … MERGE`),
- records run metadata in `ingestion_runs` (counts, warnings, status, `dry_run`).

`--dry-run` reads + dedupes + prints planned counts, then records a run row with
`dry_run=true, status='succeeded'` and writes nothing to Neo4j.

Nightly scheduling is deferred to issue #6; today the ingest runs only on demand.

### 6. Open the app

Visit `https://localhost` (or your configured host). Log in with the admin you seeded.

---

## Configuration

### Environment variables (`.env`)

| Var | Used by | Purpose |
|---|---|---|
| `DATABASE_URL_SOURCE` | ingestor | Read-only connection to source Postgres |
| `DATABASE_URL` | web, ingestor | App Postgres (users/sessions/saved_views/ingestion_runs) |
| `NEO4J_URI` | web, ingestor | e.g. `bolt://neo4j:7687` |
| `NEO4J_USER` / `NEO4J_PASSWORD` | web, ingestor | Neo4j auth |
| `NEXTAUTH_SECRET` | web | Auth.js signing secret |
| `NEXTAUTH_URL` | web | Public base URL, e.g. `https://ts-mapping.local` |
| `INGEST_CRON` | ingestor | Cron expression (default `0 2 * * *`) |
| `CADDY_TLS_MODE` | caddy | `internal` \| `tailscale` \| `acme` |
| `CADDY_DOMAIN` | caddy | Hostname Caddy should serve |

See `.env.example` for the full list with placeholder values.

### YAML configuration (hot-editable)

Two files under `config/` drive ingestor classification. Edit and re-run the ingest — no rebuild needed.

**`config/hierarchy.yaml`** — numeric `level` (float — 3.5 for Transport) per role. Each device gets `role`, `level`, and a secondary Neo4j label (e.g. `:Device:CORE`).

```yaml
levels:
  - {level: 1,   label: Core,                roles: [CORE, IRR, VRR]}
  - {level: 2,   label: Aggregation,         roles: [UPE]}
  - {level: 3,   label: CustomerAggregation, roles: [CSG, GPON, SW]}
  - {level: 3.5, label: Transport,           roles: [MW]}
  - {level: 4,   label: Access,              roles: [Ran, PTP, PMP]}
  - {level: 5,   label: Customer,            roles: [Customer]}
unknown_label: Unknown
unknown_level: 99
sw_dynamic_leveling:
  enabled: true   # post-ingest Cypher pass: SW→CORE=2, SW→Ran/Customer=4, else 3
```

**`config/role_codes.yaml`** — seeded with confirmed codes only; curate the rest over time.

```yaml
type_map:
  ICOR: CORE
  IUPE: UPE
  ICSG: CSG
  GOLT: GPON
  IIRR: IRR
  IVRR: VRR
name_prefix_map: {}      # longest-prefix wins when set
fallback: Unknown
resolver_priority: [type_column, name_prefix, fallback]
```

Resolver priority per device: raw `type_a` / `type_b` → name-prefix match → `Unknown`. Unknown codes (WLEF, ELEF, EACC, blank `type_*`, …) land in the `Unknown` bucket and are curated over time.

**How to change mappings without rebuilding:**
1. Edit the YAML files on the host (they're bind-mounted at `/app/config` inside the ingestor container).
2. Re-run the ingest: `docker compose exec ingestor npm run ingest`.
3. The next run loads the YAML fresh — no image rebuild, no restart.

---

## Operations

### Nightly ingest

`node-cron` inside the ingestor service runs at `INGEST_CRON` (default 02:00). The web UI shows a freshness badge and links to `/admin/ingestion` for the last 20 run histories.

### Manually running an ingest

```bash
docker compose exec ingestor npm run ingest                 # full run
docker compose exec ingestor npm run ingest -- --dry-run    # plan, don't write
```

Or (once S5 ships) via the admin UI: `POST /api/ingestion/run`.

### Inspecting a run

```bash
docker compose exec postgres psql -U app -c \
  "SELECT id, started_at, finished_at, status, source_rows_read, graph_edges_written, rows_dropped_null_b, rows_dropped_anomaly FROM ingestion_runs ORDER BY id DESC LIMIT 10;"
```

### Rotating passwords

- Neo4j: update `NEO4J_PASSWORD` in `.env`, restart `neo4j` + `ingestor` + `web`.
- App Postgres: update `DATABASE_URL` in `.env`, restart `web` + `ingestor`.
- Admin users: use the admin UI (`/admin/users`) or the CLI with `--force`.

### Backups

- **App Postgres**: `docker compose exec postgres pg_dump -Fc app > backups/app-$(date +%F).dump`
- **Neo4j**: reload from source Postgres — Neo4j is derived state, no backup needed for MVP.

---

## Development

### Monorepo

Managed with `pnpm` workspaces.

```
apps/
  web/           # Next.js 14 (App Router)
  ingestor/      # Node + node-cron
packages/
  config/        # YAML loaders shared between web and ingestor
  graph/         # Cypher helpers
  db/            # Drizzle schema + migrations for app Postgres
config/          # hierarchy.yaml + role_codes.yaml
caddy/           # Caddyfile
docs/decisions/  # ADRs for any deviation from canonical decisions
```

### Common commands

| Command | Purpose |
|---|---|
| `pnpm i` | Install dependencies |
| `pnpm -w typecheck` | Typecheck the whole workspace |
| `pnpm -w lint` | Lint the whole workspace |
| `pnpm -w test` | Run unit + integration tests (starts testcontainers) |
| `pnpm --filter web dev` | Start Next.js in dev mode |
| `pnpm --filter ingestor ingest -- --dry-run` | Try the ingest locally |
| `docker compose up --build` | Full stack |

### Branching and commits

- Never commit to `main`. Feature branch per issue; PR with description scoping, impact, and risk.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Bug fixes include `root cause: ...` in the commit message body and a linked failing test.

---

## Testing

- **Unit tests** cover: dedup (symmetric / one-direction / anomaly / self-loop / null-b / unicode / mixed case), role resolver (known code / unknown code / blank / conflicting type vs prefix), hierarchy resolver, SW dynamic-pass logic, saved-view visibility rules, auth helpers.
- **Integration tests** use [testcontainers](https://node.testcontainers.org/) for **real Postgres 13 + Neo4j 5** — no DB mocks. A 50-row synthetic fixture covers every edge case.
- **E2E tests** use Playwright for one happy path per feature (login → search → trace → save).
- `--dry-run` flag on the ingestor CLI is mandatory for any schema-touching change.

Run everything with `pnpm -w test`. CI runs the full suite on every push.

---

## Security & data sensitivity

> **This project ingests real operator production data.** Treat the source DB and every artifact derived from it as confidential until explicitly redacted.

- `.env` is gitignored and must stay that way. Secrets in the repo = incident.
- Source DB access is **read-only** via a dedicated role with `default_transaction_read_only=on`.
- Neo4j and web ports are **not** published to the host — only Caddy (port 443) is.
- Auth cookies are `Secure` + `SameSite=Lax` + `HttpOnly` in production. The dev-only override is clearly gated.
- Sessions are DB-backed (not JWT) so admins can revoke a user immediately.
- All authenticated state-changing actions are written to `audit_log`.
- **Before sharing any screenshot, demo, export, or diagram outside the internal network**: redact site codes, customer IDs (`mobily_cid`, `cid`), hostnames, IPs, and MAC addresses. Replace with preserved-shape placeholders (e.g. `PK-KHI-CORE-01` → `XX-YYY-CORE-01`) so the pattern stays but the identifiers don't.
- Suspected leak → rotate the affected credential, invalidate all sessions, and file an incident note in `docs/decisions/`.

---

## Roadmap

Tracked on GitHub, parent PRD [#1](https://github.com/aghaPathan/telecom-service-mapping/issues/1), slices [#2–#12](https://github.com/aghaPathan/telecom-service-mapping/issues).

| # | Slice | Status |
|---|---|---|
| [#2](https://github.com/aghaPathan/telecom-service-mapping/issues/2) | Tracer bullet — compose + health + one Neo4j node | Pending |
| [#3](https://github.com/aghaPathan/telecom-service-mapping/issues/3) | Ingestor dedup + `:Device` + `:CONNECTS_TO` | Pending |
| [#4](https://github.com/aghaPathan/telecom-service-mapping/issues/4) | Role + hierarchy resolver from YAML | Pending |
| [#5](https://github.com/aghaPathan/telecom-service-mapping/issues/5) | Sites + Services ingest | Pending |
| [#6](https://github.com/aghaPathan/telecom-service-mapping/issues/6) | Cron + observability + freshness badge | Pending |
| [#7](https://github.com/aghaPathan/telecom-service-mapping/issues/7) | Auth.js + RBAC + admin CLI | Pending |
| [#8](https://github.com/aghaPathan/telecom-service-mapping/issues/8) | Omnibox search | Pending |
| [#9](https://github.com/aghaPathan/telecom-service-mapping/issues/9) | Path trace (customer → core) | Pending |
| [#10](https://github.com/aghaPathan/telecom-service-mapping/issues/10) | Downstream / blast-radius view | Pending |
| [#11](https://github.com/aghaPathan/telecom-service-mapping/issues/11) | Caddy TLS + deploy hardening | Pending (HITL) |
| [#12](https://github.com/aghaPathan/telecom-service-mapping/issues/12) | Saved views | Pending |

**v2 candidates** (not planned yet): SPOF detection, domain/region-based RBAC, zero-downtime staging-swap ingest, Prometheus metrics, Grafana dashboards, geo visualization.

---

## Project layout

See the [Development → Monorepo](#monorepo) section. New directories, new services, and new canonical decisions go through an ADR in `docs/decisions/`.

---

## Contributing

This is an internal project. If you're picking up an issue:

1. Read `CLAUDE.md` for project-specific conventions and the data-sensitivity rules.
2. Read the parent PRD ([#1](https://github.com/aghaPathan/telecom-service-mapping/issues/1)) and the specific slice issue.
3. Branch from `main`, implement test-first, open a PR linking the issue.
4. Respect the canonical decisions table in `CLAUDE.md` — deviations require an ADR.

---

## License

Internal — not for redistribution.
