# Design — Issue #3: Ingestor dedup + `:Device` + `:CONNECTS_TO` from `app_lldp`

Date: 2026-04-22
Branch: `feat/issue-3-ingestor-lldp-dedup`
Issue: https://github.com/aghaPathan/telecom-service-mapping/issues/3

## Goal

Replace the seed-node ingestor stub with a real ingest: read `app_lldp` where
`status=true` via `DATABASE_URL_SOURCE`, apply the PRD dedup policy, and
full-refresh `:Device` + `:CONNECTS_TO` into Neo4j. Record run metadata in a
new `ingestion_runs` Postgres table. Run once on command — no cron.

## Scope fences (rejected creep)

- No cron (#6), no role/hierarchy/SW-leveling (#4), no sites/services (#5),
  no auth (#7).
- `:Device` properties only: `name, vendor, domain, ip, mac`.
- `:CONNECTS_TO` properties only: `a_if, b_if, trunk, updated_at`.
- No role-based indexes (belong to #4). Only `Device(name)` unique here.

## Five committed decisions

1. **Full-refresh strategy**: `MATCH (d:Device) DETACH DELETE d` inside one
   transaction, then batched `UNWIND … MERGE` for devices then links via
   `CALL { … } IN TRANSACTIONS OF 5000 ROWS`. Rejected run-tag sweep:
   two-phase tagging adds state for no gain when we re-read everything.

2. **Migrations tool**: `node-pg-migrate` with checked-in `.sql` files in a
   new `packages/db` workspace package. Rejected `drizzle-kit` (pulls an ORM
   we don't need until S6). Rejected raw ad-hoc SQL (no ordering guarantee).

3. **Migration runs on ingestor startup** via `packages/db` imported as a
   workspace dep — `await migrate()` before the ingest pipeline. No separate
   compose step; S6 can factor out later.

4. **Test runner**: `vitest` — native ESM, parallel, good fixture ergonomics.
   Adds one dev dep + one small `vitest.config.ts` per workspace that uses
   it.

5. **Case policy for canonical pair key**: lowercase for the key, preserve
   original hostname for the `:Device.name` property. First-seen wins for
   preserved casing.

## Architecture

```
packages/
  db/                          NEW — migrations + pg pool
    migrations/
      1700000000000_ingestion-runs.sql
    src/index.ts               pool, migrate(), shutdown()
    package.json
    tsconfig.json

apps/ingestor/
  src/
    index.ts                   entry — parse --dry-run, orchestrate
    config.ts                  env validation (zod)
    source/lldp.ts             SELECT from app_lldp WHERE status = true
    dedup.ts                   pure: rows → { devices, links, dropped, warnings }
    graph/writer.ts            Neo4j: deleteAll + mergeDevices + mergeLinks batched
    runs.ts                    ingestion_runs CRUD (startRun, finishRun)
    logger.ts                  existing
  test/
    fixtures/lldp-50.ts        synthetic fixture, zero real data
    dedup.test.ts              7 unit cases
    ingest.int.test.ts         testcontainers pg13 + neo4j5, full pipeline
  vitest.config.ts
```

## `ingestion_runs` schema (migration 1)

```sql
CREATE TYPE ingestion_status AS ENUM ('running', 'succeeded', 'failed');
CREATE TABLE ingestion_runs (
  id                    SERIAL PRIMARY KEY,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  status                ingestion_status NOT NULL DEFAULT 'running',
  source_rows_read      INTEGER,
  rows_dropped_null_b   INTEGER,
  rows_dropped_self_loop INTEGER,
  rows_dropped_anomaly  INTEGER,
  graph_nodes_written   INTEGER,
  graph_edges_written   INTEGER,
  warnings_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_text            TEXT,
  dry_run               BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ingestion_runs_started_at_idx ON ingestion_runs (started_at DESC);
```

## Dedup contract (pure function — TDD core)

```ts
type Raw = {
  device_a_name: string | null; device_a_interface: string | null;
  device_b_name: string | null; device_b_interface: string | null;
  device_a_trunk_name: string | null;
  device_a_ip: string | null;   device_a_mac: string | null;
  device_b_ip: string | null;   device_b_mac: string | null;
  vendor_a: string | null;      vendor_b: string | null;
  domain_a: string | null;      domain_b: string | null;
  updated_at: Date;
};
type DedupResult = {
  devices: DeviceProps[];      // unique by lowercase(name); preserves first-seen casing
  links:   LinkProps[];        // unique by canonical pair key; canonical direction stored
  dropped: { null_b: number; self_loop: number; anomaly: number };
  warnings: Array<{ canonical_key: string; kept_updated_at: string; discarded_count: number }>;
};
```

Canonical pair key: `${lc(min(a,b))}|${iface_at_min} ‖ ${lc(max(a,b))}|${iface_at_max}`
where `min/max` is the lexicographic lowercase comparison. Anomaly = >2 rows
per key post-merge → keep row with latest `updated_at`, rest summarized into
`warnings` (do NOT leak real hostnames in warnings beyond the canonical key,
which is already in the graph).

## Graph write phase

1. `MATCH (d:Device) DETACH DELETE d` (single implicit tx).
2. `CREATE CONSTRAINT device_name_unique IF NOT EXISTS …` (idempotent).
3. `UNWIND $devices AS d MERGE (x:Device {name: d.name}) SET x += d.props` —
   chunked on the client side into batches of 5000, each `CALL { … } IN
   TRANSACTIONS OF 5000 ROWS`.
4. `UNWIND $links AS l MATCH (a:Device {name: l.a}), (b:Device {name: l.b})
   MERGE (a)-[r:CONNECTS_TO {a_if: l.a_if, b_if: l.b_if}]->(b)
   SET r.trunk = l.trunk, r.updated_at = l.updated_at` — same batching.

Stored direction: canonical `lesser → greater` (by lowercase name).
Semantically undirected; all query code (S8/S9) must treat as such.

## CLI contract

```
ingestor [--dry-run]
  --dry-run  Read source + dedup; print planned counts; skip Neo4j writes.
             ingestion_runs row still inserted with dry_run=true, status=succeeded.
```

No other flags. `INGEST_CRON` is read but not used yet (logged as "cron
deferred to S5"), so the env key stays stable.

## Errors / verification

- Fail-fast on missing config, migration failure, or DB connectivity.
- `finishRun(status='failed', error_text=err.message)` always emitted on
  caught exceptions before rethrow.
- Exit code: `0` on success or dry-run; `1` on failure.

### Verified in session

- `dedup.test.ts` — symmetric / one-direction / anomaly / self-loop / null-b
  / unicode names / mixed-case hostnames.
- `ingest.int.test.ts` — testcontainers pg13 + neo4j5, 50-row fixture, asserts
  every edge case round-trips to the graph.
- `--dry-run` prints counts, writes nothing to Neo4j.

### NOT verified in session (flagged in PR)

- Real-dataset 221k-row < 5 min performance — no access from dev box;
  CLAUDE.md forbids reading real prod data.
- `lldp_readonly` Postgres role creation — README pre-req, not code.

## Out of scope

Anything not listed under "Scope". If it surfaces during implementation it
gets written to `memory/known-issues.md` as tech debt, not done in this PR.
