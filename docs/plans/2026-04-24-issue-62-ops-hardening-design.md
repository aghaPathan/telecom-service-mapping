# Design — Slice 5: Ops hardening (#62)

**Date:** 2026-04-24
**Parent PRD:** #57
**Issue:** #62
**Status:** Approved

Production-readiness slice. Wires the manual-ingestion trigger, ships the admin surfaces scaffolded in Slice 1, tightens compose readiness, hardens edge headers, and locks down RBAC with contract tests.

---

## 1. Architecture overview

Four independently-testable areas:

| Area | Surface | Files |
|---|---|---|
| A1 Ingestion trigger | `ingestion_triggers` table, poll loop, polling API | migration, `cron.ts`, `runs.ts`, `api/ingestion/run/route.ts`, `api/ingestion/run/[id]/route.ts` |
| A2 Admin surfaces | `/admin/ingestion`, `/admin/audit`, nav | 2 page dirs, `_components/nav.tsx` |
| A3 Compose + healthcheck | ingestor healthcheck script, compose wiring | `scripts/healthcheck.ts`, `docker-compose.yml` |
| A4 Edge hardening | Caddy HSTS/CSP, dev-page gate, ingestor ESLint | `Caddyfile.acme`, `middleware.ts`, `ingestor/eslint.config.mjs`, `ingestor/package.json` |

---

## 2. Decisions (from HITL brainstorm)

| Decision | Chosen | Reason |
|---|---|---|
| Trigger mechanism | **DB trigger-row polling** | Zero new services; Postgres-centric; aligns with DB-backed sessions ethos |
| Healthcheck semantics | **Last-run-not-failed** | Matches AC verbatim; avoids cold-start trap of freshness-based check |
| HSTS rollout | **Conservative `max-age=300`** | Irreversible cache; bump to 1-year after 7 days of clean prod |
| CSP strictness | **Permissive-but-safe (`'unsafe-inline'` allowed for now)** | AC says "reasonable defaults"; nonce-based is a separate slice |
| Dev-page gating | **Middleware** | Already exists for auth gating; centralized audit |

Both HITL items (ingestion trigger + HSTS) get ADRs with rollback procedures.

---

## 3. Data model — ingestion triggers

New migration `1700000000040_ingestion-triggers.sql`:

```sql
CREATE TABLE ingestion_triggers (
  id           BIGSERIAL PRIMARY KEY,
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ,
  run_id       BIGINT REFERENCES ingestion_runs(id)
);
CREATE INDEX ingestion_triggers_unclaimed_idx
  ON ingestion_triggers (requested_at)
  WHERE claimed_at IS NULL;
```

Partial index keeps the claim-poll query O(pending).

---

## 4. Data flow — manual trigger

```
Admin UI button
  → POST /api/ingestion/run
  → requireRole("admin") + recordAudit
  → INSERT ingestion_triggers (requested_by)
  → 201 {trigger_id}
Admin UI polls
  → GET /api/ingestion/run/:trigger_id
  → JOIN ingestion_triggers → ingestion_runs
  → {trigger_id, run_id|null, run_status|"pending"}

Ingestor tickCron (existing, every minute):
  SELECT id FROM ingestion_triggers
    WHERE claimed_at IS NULL
    ORDER BY requested_at LIMIT 1
    FOR UPDATE SKIP LOCKED;
  if found and !isRunRunning():
    startRun() → UPDATE trigger SET claimed_at=now, run_id=$runId
    run
    finishRun
  else if found and isRunRunning():
    leave unclaimed; next tick retries
```

`FOR UPDATE SKIP LOCKED` is safe under multiple ingestor replicas (we expect one, but the lock is correct either way).

---

## 5. Admin surfaces

- **`/admin/ingestion`** (server component) — top: "Run now" button (client component, POST + poll-by-id, shows toast on success/failure). Below: last 20 `ingestion_runs` rows in a table with status badge + duration + requested_by.
- **`/admin/audit`** (server component) — filters in query params (`action`, `user_id`, `date_from`, `date_to`), pagination `?page=N` (20/page). Renders `audit_log` JOIN `users` for the display name.
- **Nav** (existing `_components/nav.tsx`) — `Users`, `Audit`, **new** `Ingestion`. Gated by `session.user.role === "admin"`.

---

## 6. Edge hardening

### 6.1 Caddy (`Caddyfile.acme`)

```
header {
  Strict-Transport-Security "max-age=300"
  Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  X-Content-Type-Options "nosniff"
  Referrer-Policy "strict-origin-when-cross-origin"
  -Server
}
```

HTTP and Tailscale variants intentionally left untouched — HSTS over HTTP is useless; Tailscale is already private.

### 6.2 Dev-page gate (`middleware.ts`)

```ts
if (process.env.NODE_ENV === "production" &&
    (path === "/design-preview" || path === "/graph-preview")) {
  return new NextResponse(null, { status: 404 });
}
```

Placed after the auth guard short-circuit, before the role guards.

### 6.3 Ingestor ESLint

Flat config `eslint.config.mjs` mirroring `apps/web/eslint.config.*`:
- `@eslint/js` recommended
- `typescript-eslint` recommended
- Node globals
- Ignore `dist/`

`package.json` `lint` → `eslint .`

---

## 7. Healthcheck (A3)

`apps/ingestor/scripts/healthcheck.ts`:

```ts
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query(
    "SELECT status FROM ingestion_runs ORDER BY started_at DESC LIMIT 1"
  );
  const status = rows[0]?.status;
  if (!status || status === "success" || status === "running") process.exit(0);
  process.exit(1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await pool.end();
}
```

Compose:

```yaml
ingestor:
  healthcheck:
    test: ["CMD", "node", "dist/scripts/healthcheck.js"]
    interval: 60s
    timeout: 10s
    retries: 3
    start_period: 90s
web:
  depends_on:
    ingestor:
      condition: service_healthy
```

---

## 8. RBAC contract tests

`apps/web/test/admin-rbac.int.test.ts`:

- Table-driven over `{path, method}` covering:
  - `/api/admin/users` (GET, POST)
  - `/api/ingestion/run` (POST)
  - `/admin/users` (GET)
  - `/admin/ingestion` (GET)
  - `/admin/audit` (GET)
- For each: seed admin/operator/viewer sessions, assert 403 for non-admin, 200/201 for admin.

`apps/web/test/dev-gating.int.test.ts`:
- Spawn `next start` with `NODE_ENV=production` in a child process.
- Request `/design-preview` and `/graph-preview`, assert 404.
- Request them again with `NODE_ENV=development` (sanity check), assert 200.

---

## 9. ADRs

- `docs/decisions/0002-ingestion-trigger-mechanism.md` — schema, concurrency (`FOR UPDATE SKIP LOCKED`), rollback (drop table, revert API to 501, keep nightly cron).
- `docs/decisions/0003-hsts-rollout.md` — `max-age=300` rationale, bump procedure, rollback (`max-age=0` for the caching window), preload explicitly deferred.

---

## 10. Error handling

| Surface | Failure | Behavior |
|---|---|---|
| `POST /api/ingestion/run` | pg error | 503 `{error}` |
| `POST /api/ingestion/run` | non-admin | 403 (existing `requireRole`) |
| `GET /api/ingestion/run/:id` | unknown id | 404 |
| Healthcheck | pg error | exit 1 (unhealthy) |
| Healthcheck | last = failed | exit 1 |
| Healthcheck | no rows yet | exit 0 (bootstrap) |
| Middleware dev-gate | prod hit | 404 (no auth cost) |

---

## 11. Out of scope (explicit)

- Saved-Views admin page — AC doesn't mention; keep the nav entry pointing where it points.
- Nonce-based strict CSP — own issue/slice.
- Queue backend (BullMQ/Redis) — trigger-row design satisfies AC.
- CSP `report-uri` endpoint.
- HSTS preload submission.

---

## 12. Testing strategy

- **Unit** — `claimTrigger` logic in isolation (testcontainers pg).
- **Integration** — full trigger flow: API POST → ingestor tick → run completes → GET returns success.
- **Integration** — RBAC contract table test.
- **Integration** — dev-page gate test (spawn next start).
- **E2E (Playwright)** — admin logs in → clicks Run now → sees status flip to success on `/admin/ingestion`. Admin navigates to `/admin/audit` → filters by action → sees trigger row.

---

## 13. Rollout

1. Land migrations first (additive, no data change).
2. Land ingestor changes (claim loop + healthcheck) — backward-compatible; no triggers means no claims.
3. Land API + admin UI.
4. Land Caddy HSTS/CSP — conservative `max-age=300` so rollback cost is ≤5 min.
5. Seven days post-deploy: bump `max-age` to `31536000` in a follow-up PR if clean.
