# Ingestor LLDP Dedup + Full-Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Replace the seed-node ingestor stub with a real ingest that reads `app_lldp` via `DATABASE_URL_SOURCE`, dedupes per PRD, and full-refreshes `:Device` + `:CONNECTS_TO` into Neo4j, recording metadata in a new `ingestion_runs` Postgres table.

**Architecture:** DETACH DELETE + batched UNWIND MERGE for full refresh. A new `packages/db` workspace hosts `node-pg-migrate` migrations and a shared pool; the ingestor runs migrations on startup. Pure `dedup.ts` is the TDD core; integration tests use testcontainers (pg13 + neo4j5).

**Tech Stack:** TypeScript, pnpm workspaces, `pg`, `neo4j-driver`, `zod`, `node-pg-migrate`, `vitest`, `testcontainers`.

**Branch:** `feat/issue-3-ingestor-lldp-dedup`
**Issue:** #3
**Design:** `docs/plans/2026-04-22-issue-3-ingestor-lldp-dedup-design.md`

---

## Task 1: Bootstrap `packages/db` workspace

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/migrations/1700000000000_ingestion-runs.sql`
- Modify: `pnpm-workspace.yaml` (add `packages/*`)

**Step 1: Add `packages/*` to workspace**

```yaml
packages:
  - apps/*
  - packages/*
```

**Step 2: Write `packages/db/package.json`**

```json
{
  "name": "@tsm/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "migrate": "node-pg-migrate -m migrations -j sql --envPath ../../.env up",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "node-pg-migrate": "7.6.1",
    "pg": "8.12.0"
  },
  "devDependencies": {
    "@types/pg": "8.11.10",
    "typescript": "5.6.3"
  }
}
```

**Step 3: Write `packages/db/tsconfig.json`** — extend `tsconfig.base.json`.

**Step 4: Write migration `1700000000000_ingestion-runs.sql`** (see design doc for schema).

**Step 5: Write `packages/db/src/index.ts`** exporting:

```ts
export async function migrate(): Promise<void>;   // wraps node-pg-migrate runner against DATABASE_URL
export function getPool(): Pool;                  // singleton pg.Pool
export async function closePool(): Promise<void>;
```

**Step 6: Install deps**

```bash
pnpm install
```

**Step 7: Commit**

```bash
git add pnpm-workspace.yaml packages/db
git commit -m "feat: bootstrap @tsm/db package with node-pg-migrate (#3)"
```

---

## Task 2: Add ingestor dev deps + vitest config

**Files:**
- Modify: `apps/ingestor/package.json`
- Create: `apps/ingestor/vitest.config.ts`

**Step 1: Modify `package.json`** — add dependencies (`pg`, `zod`, `@tsm/db`), devDependencies (`vitest`, `testcontainers`, `@types/pg`), and replace `test` script with `vitest run`.

**Step 2: Write `vitest.config.ts`** — default config, test timeout 120s (testcontainers), `test/**/*.test.ts` include.

**Step 3: Install**

```bash
pnpm install
```

**Step 4: Commit**

```bash
git add apps/ingestor/package.json apps/ingestor/vitest.config.ts pnpm-lock.yaml
git commit -m "chore: add pg, zod, vitest, testcontainers to ingestor (#3)"
```

---

## Task 3: Synthetic 50-row LLDP fixture

**Files:**
- Create: `apps/ingestor/test/fixtures/lldp-50.ts`

**Step 1:** Export a `FIXTURE: RawLldpRow[]` covering every dedup case:
- 10 symmetric pairs (both-direction rows)
- 10 one-direction pairs
- 3 anomaly groups (3+ rows per key with varying `updated_at`)
- 2 self-loops (dropped)
- 2 null-`device_b_name` rows (dropped)
- 2 unicode device names (`Δ-CORE-01`, `日本-UPE-02`)
- 2 mixed-case hostname pairs (same link, one row `PK-KHI-CORE-01`, another `pk-khi-core-01`)

Rows are purely synthetic (e.g. `XX-YYY-ROLE-NN`). **Never** use real hostnames.

**Step 2: Commit**

```bash
git add apps/ingestor/test/fixtures/lldp-50.ts
git commit -m "test: synthetic 50-row lldp fixture (#3)"
```

---

## Task 4: `dedup.ts` — failing tests (RED)

**Files:**
- Create: `apps/ingestor/test/dedup.test.ts`

**Step 1: Write tests** against `dedupLldpRows(rows: RawLldpRow[]): DedupResult`. One `describe` per case:

- symmetric pair merges to 1 link, preferring non-null properties
- one-direction pair becomes 1 link
- anomaly: >2 rows per key → latest `updated_at` wins, others appear in `warnings` (length = discarded count), `dropped.anomaly` increments
- self-loop row → `dropped.self_loop += 1`, no link
- null-`device_b_name` row → `dropped.null_b += 1`, no link
- unicode device names preserved in `devices[*].name`
- mixed-case hostnames → single device with first-seen casing, single link

Assert `devices` unique by lowercase name and `links` unique by canonical key.

**Step 2: Run (expect FAIL — no impl)**

```bash
pnpm --filter ingestor test
```

Expected: all tests fail with "dedupLldpRows is not defined".

**Step 3: Commit**

```bash
git add apps/ingestor/test/dedup.test.ts
git commit -m "test: dedup unit cases for lldp pair canonicalization (#3)"
```

---

## Task 5: `dedup.ts` — implementation (GREEN)

**Files:**
- Create: `apps/ingestor/src/dedup.ts`

**Step 1: Implement**

```ts
export type RawLldpRow = { /* see design */ };
export type DeviceProps = { name: string; vendor: string | null; domain: string | null; ip: string | null; mac: string | null };
export type LinkProps = { a: string; b: string; a_if: string | null; b_if: string | null; trunk: string | null; updated_at: Date };
export type DedupResult = { devices: DeviceProps[]; links: LinkProps[]; dropped: { null_b: number; self_loop: number; anomaly: number }; warnings: Warning[] };

export function dedupLldpRows(rows: RawLldpRow[]): DedupResult { … }
```

Algorithm:
1. For each row: skip null-b (bump drop counter); skip self-loop (lowercase compare); build canonical key using lowercase min/max.
2. Group by key → if group.size > 2, keep row with latest `updated_at`, emit warning for the rest, bump `dropped.anomaly`.
3. Merge each group (≤2 rows) into one link, preferring non-null from either side for properties.
4. Device map keyed by lowercase(name); first-seen casing wins; vendor/domain/ip/mac prefer non-null.

**Step 2: Run tests (expect PASS)**

```bash
pnpm --filter ingestor test
```

**Step 3: Commit**

```bash
git add apps/ingestor/src/dedup.ts
git commit -m "feat: pure dedup of lldp rows into devices + canonical links (#3)"
```

---

## Task 6: Config loader (`config.ts`)

**Files:**
- Create: `apps/ingestor/src/config.ts`

**Step 1:** Zod-validated env: `DATABASE_URL`, `DATABASE_URL_SOURCE`, `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`. Export `loadConfig()` throwing on missing.

**Step 2: Commit**

```bash
git add apps/ingestor/src/config.ts
git commit -m "feat: zod-validated ingestor config loader (#3)"
```

---

## Task 7: Source reader (`source/lldp.ts`)

**Files:**
- Create: `apps/ingestor/src/source/lldp.ts`

**Step 1:** Export `readActiveLldpRows(sourceUrl: string): Promise<RawLldpRow[]>`. Opens short-lived `pg.Client`, runs `SELECT … FROM app_lldp WHERE status = true`, closes. Maps columns 1:1 to `RawLldpRow`.

**Step 2: Commit**

```bash
git add apps/ingestor/src/source/lldp.ts
git commit -m "feat: read active rows from app_lldp (#3)"
```

---

## Task 8: `runs.ts` — ingestion_runs CRUD

**Files:**
- Create: `apps/ingestor/src/runs.ts`

**Step 1:** Export:

```ts
export async function startRun(pool: Pool, opts: { dryRun: boolean }): Promise<number>;   // returns id
export async function finishRun(pool: Pool, id: number, payload: FinishPayload): Promise<void>;
```

`finishRun` updates `status`, `finished_at = now()`, counts, `warnings_json`, `error_text`.

**Step 2: Commit**

```bash
git add apps/ingestor/src/runs.ts
git commit -m "feat: ingestion_runs start/finish helpers (#3)"
```

---

## Task 9: Graph writer (`graph/writer.ts`)

**Files:**
- Create: `apps/ingestor/src/graph/writer.ts`

**Step 1:** Export `writeGraph(driver: Driver, data: { devices, links }): Promise<{ nodes: number; edges: number }>`. Phases:

1. `MATCH (d:Device) DETACH DELETE d` (single session).
2. `CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE`.
3. Chunk devices into slices of 5000, each slice inside `CALL { … } IN TRANSACTIONS OF 5000 ROWS` with `UNWIND $batch AS d MERGE (x:Device {name: d.name}) SET x.vendor = d.vendor, x.domain = d.domain, x.ip = d.ip, x.mac = d.mac`.
4. Same pattern for links: `UNWIND $batch AS l MATCH (a:Device {name: l.a}), (b:Device {name: l.b}) MERGE (a)-[r:CONNECTS_TO {a_if: l.a_if, b_if: l.b_if}]->(b) SET r.trunk = l.trunk, r.updated_at = l.updated_at`.

Return total counts.

**Step 2: Commit**

```bash
git add apps/ingestor/src/graph/writer.ts
git commit -m "feat: batched neo4j writer for full-refresh device + link load (#3)"
```

---

## Task 10: Entry point (`index.ts`) — rewrite

**Files:**
- Modify: `apps/ingestor/src/index.ts` (full rewrite)

**Step 1:** Orchestrate:

```
parseArgs() → loadConfig() → migrate() → pool=getPool()
runId = startRun(pool, {dryRun})
try {
  rows = readActiveLldpRows(src)
  result = dedupLldpRows(rows)
  if (dryRun) { log counts; finishRun(succeeded, dry_run=true); exit 0 }
  counts = writeGraph(driver, result)
  finishRun(pool, runId, {status:'succeeded', counts, warnings, drops})
} catch (err) { finishRun(pool, runId, {status:'failed', error_text}); throw }
finally { driver.close(); closePool() }
```

`parseArgs()`: minimal — `--dry-run` only.

**Step 2: Typecheck + build**

```bash
pnpm --filter ingestor typecheck && pnpm --filter ingestor build
```

**Step 3: Commit**

```bash
git add apps/ingestor/src/index.ts
git commit -m "feat: wire ingestor entry point with --dry-run + run metadata (#3)"
```

---

## Task 11: Integration test (testcontainers)

**Files:**
- Create: `apps/ingestor/test/ingest.int.test.ts`

**Step 1: Write test** using `@testcontainers/postgresql` and `@testcontainers/neo4j` (or generic `GenericContainer`):

1. Start pg13 + neo4j5 containers.
2. Seed source pg with fixture rows (inline `CREATE TABLE app_lldp` mimicking source schema subset).
3. Run `migrate()` against app pg (separate DB).
4. Import and call the ingestor as library (refactor `index.ts` so `runIngest(opts)` is exported), with both `DATABASE_URL` and `DATABASE_URL_SOURCE` pointing at the container (could be the same pg with two schemas, or two containers).
5. Assert Neo4j has expected node + edge counts, unicode names preserved, mixed-case merged, anomalies reflected in `ingestion_runs.warnings_json`.
6. Run again with `--dry-run` and assert Neo4j unchanged.

**Step 2: Refactor `index.ts`** if needed so `runIngest` is exported (CLI wraps it).

**Step 3: Run**

```bash
pnpm --filter ingestor test
```

**Step 4: Commit**

```bash
git add apps/ingestor/test/ingest.int.test.ts apps/ingestor/src/index.ts
git commit -m "test: end-to-end testcontainers ingest round-trip (#3)"
```

---

## Task 12: Dockerfile + compose wiring

**Files:**
- Modify: `apps/ingestor/Dockerfile` (add `packages/db` to deps stage)
- Modify: `docker-compose.yml` (ensure ingestor depends on pg health, has DATABASE_URL_SOURCE)

**Step 1:** Copy `packages/db/package.json` in deps stage; build context already root. Use `pnpm --filter ingestor... deploy` to vendor `@tsm/db`.

**Step 2: Verify compose file** already has `DATABASE_URL_SOURCE` (it does). No new ports exposed.

**Step 3: Local build smoke**

```bash
docker compose build ingestor
```

**Step 4: Commit**

```bash
git add apps/ingestor/Dockerfile docker-compose.yml
git commit -m "build: bundle @tsm/db into ingestor image (#3)"
```

---

## Task 13: README updates

**Files:**
- Modify: `README.md`

**Step 1:** Add a "Source DB prerequisite" section documenting the `lldp_readonly` role creation (read-only, `default_transaction_read_only=on`, SELECT on `app_lldp` only for S2) and how to set `DATABASE_URL_SOURCE`. Add a "Running the ingestor" subsection with `--dry-run` usage.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: ingestor prereqs + dry-run usage (#3)"
```

---

## Task 14: Verification pass

**Files:** none (pure verification, invoke `superpowers:verification-before-completion`)

**Step 1:** Full suite

```bash
pnpm --filter ingestor typecheck
pnpm --filter ingestor test
pnpm --filter @tsm/db typecheck
docker compose build ingestor
```

**Step 2:** Manually verify `--dry-run` path prints counts and inserts `ingestion_runs` row with `dry_run=true`, `status='succeeded'`, no Neo4j writes. (Against testcontainer instances — we cannot hit the real source DB.)

**Step 3:** Confirm acceptance-criteria checklist. Every item either green-in-test or explicitly flagged as "not verified in session" (perf + `lldp_readonly` role).

---

## Task 15: Agent-pipeline review

Invoke `agent-pipeline` skill (code-architect → test-writer → code-reviewer → security-auditor → code-simplifier → doc-writer) on the diff vs `main`. Address any blocker findings; optional findings noted in PR body.

---

## Task 16: PR + merge

**Step 1: Push**

```bash
git push -u origin feat/issue-3-ingestor-lldp-dedup
```

**Step 2: `gh pr create`** with the body template from the issues-to-complete skill (closes #3, parent #1, checkbox verification).

**Step 3:** Wait for CI (`gh pr checks <N> --watch`), then `gh pr merge <N> --squash --delete-branch`.

---

## Execution

Plan saved to `docs/plans/issue-3-ingestor-lldp-dedup.md`. Proceeding with **subagent-driven-development** in this session per issues-to-complete flow.
