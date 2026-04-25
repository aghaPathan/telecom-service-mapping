# Issue #67 — ISIS cost ingestion from ClickHouse — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if invoked from the orchestrator) to implement this plan task-by-task.

**Goal:** Wire the ingestor to pull ISIS edge cost from ClickHouse `lldp_data.isis_cost` and write `weight`, `weight_source`, `weight_observed_at` onto `:CONNECTS_TO` so the weighted-shortest-path code shipped in PR #66 has real data and the "unweighted path" banner stops firing on Huawei-only paths.

**Architecture:** New ingest stage runs after dedup and before/atomic-with the existing graph write. ClickHouse query uses `argMax(ISIS_COST, RecordDateTime) GROUP BY` for most-recent-per-edge dedup. Edge match is the canonical unordered interface pair (per ADR 0004). Admin trigger gains a `flavor` column (`'full' | 'isis_cost'`) so operators can refresh ISIS cost without a full LLDP run. Connection failures surface in `ingestion_runs.warnings` and DO NOT touch existing `weight` properties.

**Tech Stack:** TypeScript / Node 20, `@clickhouse/client` (NEW dep), Neo4j 5, Postgres 13, vitest + testcontainers (`clickhouse/clickhouse-server:22.3`), Next.js 14 App Router.

**Spec sources:**
- Issue #67 (acceptance criteria)
- ADR 0004 (`docs/decisions/0004-isis-weight-policy.md`) — edge-match key, set-level null propagation, edge schema
- ADR 0002-ingestion-trigger-mechanism (existing trigger pattern)
- Pre-existing in-flight unstaged edit on `.env.example` adds `CLICKHOUSE_ISIS_TABLE` and `CLICKHOUSE_TIMEOUT_MS` — incorporate, do not discard.

**Pitfalls (from CLAUDE.md):**
- ClickHouse server pin must be `22.3` to match V1 source.
- No mocks of CH — testcontainers only.
- Never log row contents (real production hostnames / CIDs).
- Build `@tsm/db` before downstream typecheck if any new shared exports added.
- `ingestion_runs.status` values are `running`/`succeeded`/`failed` (not `success`).
- `apps/web/test/admin-rbac.int.test.ts` ROUTES table must be extended for any new admin route added.
- `vitest.workspace.ts` must list any new test paths if outside existing globs.

---

## Task 1: Env placeholders + config loader for ClickHouse

**Files:**
- Modify: `.env.example` (incorporate in-flight diff; add `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`; preserve `CLICKHOUSE_ISIS_TABLE`, `CLICKHOUSE_TIMEOUT_MS`; add trailing newline)
- Modify: `apps/ingestor/src/config.ts` — extend `IngestorConfig` with optional `clickhouse?: { url, user, password, database, isisTable, timeoutMs }`. Optional so the ingestor still boots when CH isn't configured (graceful degradation per AC2).
- Test: `apps/ingestor/test/config.test.ts` (create if missing) — assert presence/absence parsing.

**Step 1: Inspect current state**

```bash
git diff .env.example
cat apps/ingestor/src/config.ts
```

**Step 2: RED — write failing test**

Add to `apps/ingestor/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig — clickhouse", () => {
  it("returns clickhouse undefined when CLICKHOUSE_URL is unset", () => {
    const cfg = loadConfig({ DATABASE_URL_SOURCE: "x", DATABASE_URL: "y", NEO4J_URI: "z", NEO4J_USERNAME: "u", NEO4J_PASSWORD: "p" });
    expect(cfg.clickhouse).toBeUndefined();
  });
  it("populates clickhouse block when CLICKHOUSE_URL is set", () => {
    const cfg = loadConfig({
      DATABASE_URL_SOURCE: "x", DATABASE_URL: "y",
      NEO4J_URI: "z", NEO4J_USERNAME: "u", NEO4J_PASSWORD: "p",
      CLICKHOUSE_URL: "http://ch:8123",
      CLICKHOUSE_USER: "default",
      CLICKHOUSE_PASSWORD: "secret",
      CLICKHOUSE_DATABASE: "lldp_data",
    });
    expect(cfg.clickhouse).toEqual({
      url: "http://ch:8123",
      user: "default",
      password: "secret",
      database: "lldp_data",
      isisTable: "isis_cost",
      timeoutMs: 10000,
    });
  });
});
```

Run: `pnpm --filter ingestor test config.test.ts` — expect FAIL.

**Step 3: GREEN — implement**

In `apps/ingestor/src/config.ts` extend the loader. Keep `loadConfig` argument-injectable (pass `process.env` from the entrypoint) for testability.

**Step 4: Verify**

`pnpm --filter ingestor test config.test.ts` — PASS.

**Step 5: Update `.env.example`** — add the four required keys above the existing in-flight `CLICKHOUSE_ISIS_TABLE` line; add trailing newline. No real values.

**Step 6: Commit**

```
feat(ingestor): add ClickHouse config loader and env placeholders (#67)
```

---

## Task 2: Migration — `flavor` column on `ingestion_triggers`

**Files:**
- Create: `packages/db/migrations/<NNN>_ingestion_trigger_flavor.sql`
- Modify: `packages/db/src/schema-types.ts` (or wherever the row type lives) — add `flavor: 'full' | 'isis_cost'`
- Test: `apps/ingestor/test/triggers.int.test.ts` — extend to assert default + explicit flavor round-trip

**Step 1:** `ls packages/db/migrations/ | tail -5` to find next number.

**Step 2: RED**

Add a test case asserting `claimNextTrigger` returns the `flavor` field (defaulting to `'full'`).

**Step 3: GREEN — write migration**

```sql
ALTER TABLE ingestion_triggers
  ADD COLUMN flavor TEXT NOT NULL DEFAULT 'full'
    CHECK (flavor IN ('full', 'isis_cost'));
```

**Step 4:** Update `claimNextTrigger` in `apps/ingestor/src/triggers.ts` to `SELECT … flavor` and propagate via `ClaimedTrigger`.

**Step 5:** Update `createTrigger` in `apps/web/lib/ingestion-triggers.ts` to accept an optional `flavor` arg defaulting to `'full'`.

**Step 6: Verify** `pnpm --filter ingestor test triggers.int.test.ts && pnpm --filter @tsm/db build && pnpm --filter web typecheck`.

**Step 7: Commit**

```
feat(db): add flavor column to ingestion_triggers (#67)
```

---

## Task 3: ClickHouse source reader (testcontainer-driven)

**Files:**
- Create: `apps/ingestor/src/source/isis-cost.ts`
- Create: `apps/ingestor/test/isis-cost-source.int.test.ts`
- Modify: `apps/ingestor/package.json` — add `@clickhouse/client` (pin to a single version)

**Step 1:** Add `@clickhouse/client` and run `pnpm install`.

**Step 2: RED**

`apps/ingestor/test/isis-cost-source.int.test.ts`:
- Boots `clickhouse/clickhouse-server:22.3`.
- Creates `lldp_data.isis_cost` matching the live schema (columns: `Device_A_Name, Device_A_Interface, ISIS_COST Int64, Device_B_Name, Device_B_Interface, Vendor String, RecordDateTime DateTime`). Engine: `MergeTree() ORDER BY (Device_A_Name, Device_A_Interface, Device_B_Name, Device_B_Interface, RecordDateTime)`.
- Seeds 6 rows — three for one canonical pair across three `RecordDateTime`s + one for a different pair + one self-loop + one with NULL interface.
- Calls `readIsisCost({ url, user, password, database, isisTable, timeoutMs })` and asserts:
  - returns one row per canonical pair (argMax dedup)
  - drops NULL-interface rows
  - drops self-loops (`Device_A_Name = Device_B_Name AND Device_A_Interface = Device_B_Interface`)
  - returned `weight` is the `ISIS_COST` from the row with the **latest** `RecordDateTime`
  - `observed_at` carries that latest `RecordDateTime`

Run: `pnpm --filter ingestor test isis-cost-source.int.test.ts` — FAIL (file missing).

**Step 3: GREEN — implement reader**

```ts
// apps/ingestor/src/source/isis-cost.ts
import { createClient } from "@clickhouse/client";

export type IsisCostRow = {
  device_a_name: string;
  device_a_interface: string;
  device_b_name: string;
  device_b_interface: string;
  weight: number;
  observed_at: Date;
};

export type IsisCostConfig = {
  url: string; user: string; password: string;
  database: string; isisTable: string; timeoutMs: number;
};

export async function readIsisCost(cfg: IsisCostConfig): Promise<IsisCostRow[]> {
  const client = createClient({
    url: cfg.url,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    request_timeout: cfg.timeoutMs,
  });
  try {
    const rs = await client.query({
      query: `
        SELECT
          Device_A_Name      AS device_a_name,
          Device_A_Interface AS device_a_interface,
          Device_B_Name      AS device_b_name,
          Device_B_Interface AS device_b_interface,
          argMax(ISIS_COST, RecordDateTime) AS weight,
          max(RecordDateTime)               AS observed_at
        FROM ${cfg.database}.${cfg.isisTable}
        WHERE Device_A_Name IS NOT NULL
          AND Device_B_Name IS NOT NULL
          AND Device_A_Interface IS NOT NULL
          AND Device_B_Interface IS NOT NULL
          AND NOT (Device_A_Name = Device_B_Name
                   AND Device_A_Interface = Device_B_Interface)
        GROUP BY Device_A_Name, Device_A_Interface,
                 Device_B_Name, Device_B_Interface
      `,
      format: "JSONEachRow",
    });
    const rows = await rs.json<{
      device_a_name: string; device_a_interface: string;
      device_b_name: string; device_b_interface: string;
      weight: string | number; observed_at: string;
    }>();
    return rows.map((r) => ({
      device_a_name: r.device_a_name,
      device_a_interface: r.device_a_interface,
      device_b_name: r.device_b_name,
      device_b_interface: r.device_b_interface,
      weight: typeof r.weight === "string" ? Number(r.weight) : r.weight,
      observed_at: new Date(r.observed_at + "Z"),
    }));
  } finally {
    await client.close();
  }
}
```

`isisTable` is interpolated, NOT parameterized — ClickHouse refuses parameter binding for table names. Validate it elsewhere if it ever becomes user-supplied (for now it's env-only).

**Step 4:** Run test — PASS.

**Step 5: Commit**

```
feat(ingestor): add ClickHouse isis-cost source reader with argMax dedup (#67)
```

---

## Task 4: Canonical edge-pair dedup at the JS layer (orientation-agnostic)

ClickHouse already groups by ordered key; we still need to fold both directions (`A→B` and `B→A`) onto the same canonical edge to satisfy AC5.

**Files:**
- Create: `apps/ingestor/src/isis-cost-dedup.ts`
- Create: `apps/ingestor/test/isis-cost-dedup.unit.test.ts`

**Step 1: RED**

```ts
import { describe, expect, it } from "vitest";
import { canonicalizeIsisRows } from "../src/isis-cost-dedup.ts";

describe("canonicalizeIsisRows", () => {
  it("collapses A→B and B→A into one canonical record (latest observed_at wins)", () => {
    const rows = [
      { device_a_name: "DEV-A", device_a_interface: "Eth1", device_b_name: "DEV-B", device_b_interface: "Eth2",
        weight: 10, observed_at: new Date("2025-02-01T00:00:00Z") },
      { device_a_name: "DEV-B", device_a_interface: "Eth2", device_b_name: "DEV-A", device_b_interface: "Eth1",
        weight: 12, observed_at: new Date("2025-02-14T00:00:00Z") },
    ];
    const out = canonicalizeIsisRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.weight).toBe(12);
  });
});
```

**Step 2: GREEN** — implement using a sorted-pair join key (`[a,if_a,b,if_b]` lexicographic sort).

**Step 3: Commit**

```
feat(ingestor): canonical-pair dedup for isis-cost rows (#67)
```

---

## Task 5: Graph writer — write weight onto `:CONNECTS_TO` (orientation-agnostic match)

**Files:**
- Modify: `apps/ingestor/src/graph/writer.ts` — add `writeIsisWeights(driver, rows)` exported function
- Test: `apps/ingestor/test/ingest.int.test.ts` (or new dedicated `isis-weights.int.test.ts`)

**Step 1: RED**

New int test that:
1. Seeds two `:Device` nodes and one `:CONNECTS_TO` edge with `weight: null`.
2. Calls `writeIsisWeights(driver, [{a, if_a, b, if_b, weight: 7, observed_at: T}])` with **swapped** orientation (request as B→A, edge stored A→B).
3. Asserts the same edge ends up with `weight=7, weight_source='observed', weight_observed_at=T`.
4. Re-runs `writeIsisWeights` with empty array → existing weight stays `7` (no nulling).
5. Asserts edges with NO matching ISIS row keep their existing `weight` untouched.

**Step 2: GREEN — implement**

```cypher
UNWIND $batch AS r
MATCH (a:Device {name: r.a})-[e:CONNECTS_TO]-(b:Device {name: r.b})
WHERE (e.a_if = r.if_a AND e.b_if = r.if_b)
   OR (e.a_if = r.if_b AND e.b_if = r.if_a)
SET e.weight             = toFloat(r.weight),
    e.weight_source      = 'observed',
    e.weight_observed_at = datetime(r.observed_at)
RETURN count(e) AS matched
```

Important: this MERGE-style update never sets `weight = null`. Edges without a CH row are left untouched, satisfying AC2's "missing ClickHouse must leave existing weights intact, not null them" and AC4's "no `weight_source` on unmatched edges" (since we never write).

**Step 3: Verify** PASS, then run the full int suite.

**Step 4: Commit**

```
feat(ingestor): write isis weight + source + observed_at onto CONNECTS_TO (#67)
```

---

## Task 6: Wire ISIS stage into `runIngest` with safe-fail semantics

**Files:**
- Modify: `apps/ingestor/src/index.ts` — call ISIS stage after the existing graph write
- Modify: `apps/ingestor/src/runs.ts` — extend `warnings` shape to carry `{ stage: 'isis_cost', error: string }` rows
- Test: extend `apps/ingestor/test/ingest.int.test.ts`

**Step 1: RED**

Test cases:
- Happy path: CH testcontainer up → run ingest with `clickhouse` config set → `:CONNECTS_TO.weight` populated for the 50-row fixture's matching pairs.
- Failure path: `clickhouse.url` set to a port that refuses connections → ingest still succeeds (`status='succeeded'`), but `ingestion_runs.warnings` contains a row tagged `stage='isis_cost'`, and the existing `:CONNECTS_TO.weight` values from the previous run are unchanged.
- Disabled path: `clickhouse` config absent → no warning, no error, stage skipped silently.

**Step 2: GREEN — implement**

In `index.ts`, after the existing graph write:

```ts
if (config.clickhouse) {
  try {
    const raw = await readIsisCost(config.clickhouse);
    const canonical = canonicalizeIsisRows(raw);
    const matched = await writeIsisWeights(driver, canonical);
    log("info", "isis_weights_written", { rows_in: raw.length, edges_matched: matched });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push({ stage: "isis_cost", error: msg });
    log("warn", "isis_weights_failed", { error: msg });
  }
}
```

**Step 3: Verify** all three cases.

**Step 4: Commit**

```
feat(ingestor): integrate ISIS-cost stage with safe-fail isolation (#67)
```

---

## Task 7: Cron honours trigger flavor — ISIS-only path

**Files:**
- Modify: `apps/ingestor/src/cron.ts` — `runFn` signature gains `flavor` from claimed trigger
- Modify: `apps/ingestor/src/index.ts` — `runIngest({ flavor: 'full' | 'isis_cost' })`. When `'isis_cost'`, skip LLDP/DWDM/Sites/Services and run ONLY `readIsisCost → canonicalize → writeIsisWeights`. Still records an `ingestion_runs` row.
- Test: extend `apps/ingestor/test/cron.int.test.ts`

**Step 1: RED**

Test that inserts `ingestion_triggers (flavor='isis_cost')` and asserts:
- a run row is written with `status='succeeded'`
- LLDP source is NOT queried (assert via row counts on existing `:CONNECTS_TO` — should be unchanged)
- ISIS weights are written

**Step 2: GREEN — implement**

`tickCron` already returns `claimNextTrigger`; pass `trigger?.flavor ?? 'full'` to `runFn`. Branch in `runIngest`.

**Step 3: Commit**

```
feat(ingestor): isis-cost-only run flavor for on-demand refresh (#67)
```

---

## Task 8: Web — admin trigger UI accepts flavor + status badge + coverage %

**Files:**
- Modify: `apps/web/lib/ingestion-triggers.ts` — `createTrigger(userId, flavor)`
- Modify: `apps/web/app/api/ingestion/run/route.ts` — accept JSON body `{ flavor }` (default `'full'`); validate via Zod
- Modify: `apps/web/app/admin/ingestion/run-now-button.tsx` — add "Run ISIS-cost only" secondary button
- Create: `apps/web/lib/isis-status.ts` — query Neo4j for `max(weight_observed_at)` and coverage % (`COUNT(weight IS NOT NULL) / COUNT(*)`)
- Modify: `apps/web/app/admin/ingestion/page.tsx` — render freshness badge with amber styling at >30 days stale
- Test: `apps/web/test/isis-status.int.test.ts` (new) + extend `apps/web/test/admin-rbac.int.test.ts` ROUTES table for any new admin endpoint

**Step 1: RED — backend tests**
- Validate Zod rejects unknown flavor.
- `getIsisFreshness()` returns `{ latest: Date|null, coveragePct: number }` from a seeded testcontainer Neo4j.
- Fresh fixture (observed_at within 30d) → not stale; stale fixture (>30d ago) → `stale: true`.

**Step 2: RED — UI test**

Render `<IsisFreshnessBadge data={{latest: 31-days-ago, coveragePct: 0.42}}/>` and assert amber styling class + 31d label + `42%`. Use `renderToStaticMarkup`.

**Step 3: GREEN — implement**

- Backend: extend route handler with Zod parse, call `createTrigger(userId, parsed.flavor)`.
- UI: button renders "Run now" (full) and "Run ISIS-cost only"; both POST to `/api/ingestion/run` with body.
- Badge: server component queries Neo4j once per request (revalidate 5s, mirror existing pattern).

**Step 4: Verify** `pnpm --filter web test && pnpm --filter web test:int && pnpm --filter web typecheck`.

**Step 5: Commit**

```
feat(web): admin ISIS-cost flavor trigger + freshness badge + coverage % (#67)
```

---

## Task 9: End-to-end assertion — banner stops firing on Huawei-only path

**Files:**
- Create: `apps/web/test/path-isis-weighted.int.test.ts` (or extend an existing one) — uses the ingestor and a 50-row CH fixture mapped onto the existing 50-row LLDP fixture so an all-Huawei-edge candidate set ends up `weighted=true`.

**Step 1: RED** — assert `runPath(src, dst).weighted === true` for an all-Huawei-edge fixture.

**Step 2: GREEN** — fall out from prior tasks; if not green, debug the canonical-pair join.

**Step 3: Commit**

```
test(web): assert weighted path on all-Huawei seeded fixture (#67)
```

---

## Task 10: Update ADR 0004 — close `weight_source` / `weight_observed_at` deferrals

**Files:**
- Modify: `docs/decisions/0004-isis-weight-policy.md` — append a "PR 2 closure" section noting:
  - `weight_source` is `'observed'` when set (no other values introduced; future per-vendor diagnostic still deferred).
  - `weight_observed_at` is the `RecordDateTime` from the latest CH row for that canonical pair.
  - Edges without a CH match keep `weight: null` and have NO `weight_source` set.
  - Connection failures isolate to `ingestion_runs.warnings` and never null existing weights.

**Step 1:** Read current ADR, draft the addendum.

**Step 2:** Commit:

```
docs(adr): close weight_source / weight_observed_at deferrals in ADR 0004 (#67)
```

---

## Task 11: Final verification + manual ack

**Step 1:** Full test suite — `pnpm -r typecheck && pnpm -r lint && pnpm --filter ingestor test && pnpm --filter web test && pnpm --filter web test:int`.

**Step 2:** Compose smoke — `cp .env.example .env && docker compose build && docker compose up -d --wait` (won't actually pull from real CH; smoke just verifies container boots).

**Step 3:** Walk acceptance criteria — open issue #67 and tick each box mentally with the verifying test name.

**Step 4:** Close #60's AC #1 ticking (note in PR body that `Closes #67` and references the unblocked AC of #60).

---

## Acceptance Criteria → Test mapping

| AC | Verified by |
|----|-------------|
| 1. Env placeholders | Task 1 — `.env.example` diff in commit |
| 2. CH connect failure preserves weights | Task 6 — failure-path int test |
| 3. argMax dedup with 50-row fixture | Task 3 — `isis-cost-source.int.test.ts` |
| 4. Edge property triple write | Task 5 — `isis-weights.int.test.ts` |
| 5. Canonical unordered match | Task 4 + Task 5 — both orientations in seed |
| 6. Admin trigger isis-cost-only flavour | Task 7 + Task 8 — cron + UI tests |
| 7. Freshness badge + coverage % + amber stale | Task 8 — UI test |
| 8. Weighted=true on Huawei-only path | Task 9 — e2e int test |
| 9. ADR 0004 closure note | Task 10 |

---

## Out of scope / deferred

- Per-vendor weight diagnostic column (already deferred in ADR 0004; v2.1).
- Multi-vendor metric-scale normalization.
- Algorithm changes in `apps/web/lib/path.ts` — issue is ingestion-only.

## Execution Handoff

After this plan is committed, execution options:

1. **Subagent-driven** (this session, fastest) — `superpowers:subagent-driven-development` dispatches one fresh subagent per task with code review between tasks.
2. **Parallel session** — open a new session in this worktree and run `superpowers:executing-plans`.

Ask the user which to take.
