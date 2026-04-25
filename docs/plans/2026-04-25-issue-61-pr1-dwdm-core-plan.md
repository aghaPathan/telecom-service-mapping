# Issue #61 PR 1 — DWDM Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Ingest `public.dwdm` and `app_cid` from the source Postgres into Neo4j as `:DWDM_LINK` edges and `:CID` nodes, render `/dwdm` list + `/dwdm/[node]` + `/dwdm/ring/[ring]` pages backed by the new model, and land the five contract rules (#19/#20/#21/#27/#28) deferred from #59.

**Architecture:** Mirrors the existing LLDP ingest → dedup → writer pipeline (`apps/ingestor/src/source/lldp.ts`, `dedup.ts`, `graph/writer.ts`). Adds two new source readers (`source/dwdm.ts`, `source/cid.ts`), a pure CID parser (`cid-parser.ts`), DWDM dedup, and a writer phase that `MERGE`s `:DWDM_LINK` edges + `:CID` nodes inside the same nightly transaction. Web side adds `lib/dwdm.ts` Cypher queries, `/api/dwdm` + `/api/dwdm/graph` routes, and three Next.js pages. `protection_cid` is stored on `:CID` (not `:DWDM_LINK`) per V1 ground truth.

**Tech Stack:** TypeScript (Node 20, Next.js App Router), pg, neo4j-driver, vitest + testcontainers (Postgres 13 + Neo4j 5), zod, pnpm workspace.

**Source design:** `docs/plans/2026-04-25-issue-61-v2-slice-4-design.md`.

**Acceptance criteria covered (from issue #61):** 1, 2, 3, 4. (PR 2 covers AC 5; PR 3 covers ACs 6, 7; PR 4 covers ACs 8, 9, 10.)

**Branch:** `feat/issue-61-v2-slice-4` (PR title will be `feat: DWDM ingest + /dwdm pages + CID parser (#61, PR 1/4)`; body will say `Refs #61` not `Closes`).

---

## Phase A — Pure CID parser (no IO, no containers)

### Task A1: Failing tests for `stripSpanSuffix` (rules #19, #27)

**Files:**
- Create: `apps/ingestor/test/cid-parser.unit.test.ts`
- Create: `apps/ingestor/src/cid-parser.ts` (empty exports for now)

**Step 1: Write the failing tests**

```ts
// apps/ingestor/test/cid-parser.unit.test.ts
import { describe, it, expect } from "vitest";
import { stripSpanSuffix } from "../src/cid-parser.js";

describe("stripSpanSuffix (V1 contract rules #19, #27)", () => {
  it("strips ' -  LD' suffix (note: two spaces before LD)", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B -  LD")).toBe("CITY-A - CITY-B");
  });
  it("strips ' - NSR' suffix (rule #27 — V1 elif was unreachable)", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B - NSR")).toBe("CITY-A - CITY-B");
  });
  it("trims trailing whitespace after stripping", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B -  LD   ")).toBe("CITY-A - CITY-B");
  });
  it("returns input unchanged when no suffix present", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B")).toBe("CITY-A - CITY-B");
  });
  it("returns null for null/empty input", () => {
    expect(stripSpanSuffix(null)).toBeNull();
    expect(stripSpanSuffix("")).toBeNull();
  });
  it("strips both branches independently — input with both suffixes only carries one", () => {
    // V1 input was always one or the other; we don't compose.
    expect(stripSpanSuffix("X -  LD")).toBe("X");
    expect(stripSpanSuffix("X - NSR")).toBe("X");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter ingestor exec vitest run test/cid-parser.unit.test.ts
```

Expected: FAIL — `stripSpanSuffix is not exported`.

**Step 3: Minimal implementation**

```ts
// apps/ingestor/src/cid-parser.ts
/**
 * V1 source: data_populate.py:36-42. V1 had `elif` between LD and NSR which
 * meant NSR was unreachable for inputs with both substrings — V2 contract
 * rule #27 fixes by handling each branch independently.
 */
export function stripSpanSuffix(s: string | null): string | null {
  if (s === null || s === "") return null;
  let out = s;
  if (out.includes(" -  LD")) out = out.split(" -  LD")[0];
  if (out.includes(" - NSR")) out = out.split(" - NSR")[0];
  return out.trim();
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter ingestor exec vitest run test/cid-parser.unit.test.ts
```

Expected: 6 tests pass.

**Step 5: Commit**

```bash
git add apps/ingestor/src/cid-parser.ts apps/ingestor/test/cid-parser.unit.test.ts
git commit -m "$(cat <<'EOF'
feat(ingestor): stripSpanSuffix — contract rules #19, #27 (#61)

LD then NSR independently (V1 elif was unreachable).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: Failing tests for `parseCidList`

**Files:**
- Modify: `apps/ingestor/test/cid-parser.unit.test.ts`
- Modify: `apps/ingestor/src/cid-parser.ts`

**Step 1: Append tests**

```ts
import { stripSpanSuffix, parseCidList } from "../src/cid-parser.js";

describe("parseCidList", () => {
  it("space-splits a CID string", () => {
    expect(parseCidList("CID1 CID2 CID3")).toEqual(["CID1", "CID2", "CID3"]);
  });
  it("comma-splits a CID string", () => {
    expect(parseCidList("CID1,CID2,CID3")).toEqual(["CID1", "CID2", "CID3"]);
  });
  it("mixed separators", () => {
    expect(parseCidList("CID1, CID2 CID3")).toEqual(["CID1", "CID2", "CID3"]);
  });
  it("drops empty tokens", () => {
    expect(parseCidList("CID1   CID2")).toEqual(["CID1", "CID2"]);
  });
  it("returns [] for null/empty/'nan'", () => {
    expect(parseCidList(null)).toEqual([]);
    expect(parseCidList("")).toEqual([]);
    expect(parseCidList("nan")).toEqual([]);
  });
  it("trims surrounding whitespace per token", () => {
    expect(parseCidList("  CID1  ,  CID2  ")).toEqual(["CID1", "CID2"]);
  });
});
```

**Step 2: Run — expect FAIL on `parseCidList not exported`**

```bash
pnpm --filter ingestor exec vitest run test/cid-parser.unit.test.ts
```

**Step 3: Implement**

```ts
// append to apps/ingestor/src/cid-parser.ts
export function parseCidList(s: string | null): string[] {
  if (s === null) return [];
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return [];
  return trimmed
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
```

**Step 4: Run — expect 12 tests pass**

**Step 5: Commit**

```bash
git add apps/ingestor/src/cid-parser.ts apps/ingestor/test/cid-parser.unit.test.ts
git commit -m "feat(ingestor): parseCidList — space/comma split, drop blanks (#61)"
```

---

### Task A3: Failing tests for `parseProtectionCids` (rules #20, #21)

**Step 1: Append tests**

```ts
import { stripSpanSuffix, parseCidList, parseProtectionCids } from "../src/cid-parser.js";

describe("parseProtectionCids (V1 contract rules #20, #21)", () => {
  it("rule #20: 'nan' → []", () => {
    expect(parseProtectionCids("nan")).toEqual([]);
  });
  it("rule #20: empty/null → []", () => {
    expect(parseProtectionCids("")).toEqual([]);
    expect(parseProtectionCids(null)).toEqual([]);
  });
  it("rule #21: space-split, preserve order — first is the protection CID per V1 Topo.py:920", () => {
    expect(parseProtectionCids("PCID1 PCID2 PCID3")).toEqual(["PCID1", "PCID2", "PCID3"]);
  });
  it("single CID string returns single-element list", () => {
    expect(parseProtectionCids("PCID1")).toEqual(["PCID1"]);
  });
});
```

**Step 2: Run — expect FAIL**

**Step 3: Implement**

```ts
// append to apps/ingestor/src/cid-parser.ts
/**
 * V1 source: Topo.py:914-920. The first element of the split is the
 * protection CID name V1 actually uses; we preserve full list ordering
 * so callers can pick proc_cids[0] explicitly.
 */
export function parseProtectionCids(s: string | null): string[] {
  if (s === null) return [];
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return [];
  return trimmed.split(/\s+/).filter((t) => t.length > 0);
}
```

**Step 4: Run — expect 16 tests pass**

**Step 5: Commit**

```bash
git add apps/ingestor/src/cid-parser.ts apps/ingestor/test/cid-parser.unit.test.ts
git commit -m "$(cat <<'EOF'
feat(ingestor): parseProtectionCids — contract rules #20, #21 (#61)

'nan' / empty → []; otherwise space-split preserving order. Callers pick
[0] for V1's "first protection CID" semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Source readers (testcontainer)

### Task B1: `RawDwdmRow` type + `readDwdmRows`

**Files:**
- Create: `apps/ingestor/src/source/dwdm.ts`
- Create: `apps/ingestor/test/dwdm-source.int.test.ts`

**Step 1: Write the failing testcontainer test**

```ts
// apps/ingestor/test/dwdm-source.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { readDwdmRows } from "../src/source/dwdm.js";

const { Client } = pg;
let pgContainer: StartedPostgreSqlContainer;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:13").start();
  const c = new Client({ connectionString: pgContainer.getConnectionUri() });
  await c.connect();
  await c.query(`
    CREATE TABLE public.dwdm (
      device_a_name      text,
      device_a_interface text,
      device_a_ip        text,
      device_b_name      text,
      device_b_interface text,
      device_b_ip        text,
      "Ring"             text,
      snfn_cids          text,
      mobily_cids        text,
      span_name          text
    );
    INSERT INTO public.dwdm VALUES
      ('XX-AAA-DWDM-01','OTU1','10.0.0.1','XX-BBB-DWDM-01','OTU1','10.0.0.2','RING-1','S1 S2','M1','XX-AAA - XX-BBB -  LD'),
      ('XX-CCC-DWDM-01','OTU2','10.0.0.3','XX-DDD-DWDM-01','OTU2','10.0.0.4','RING-2','S3','M2 M3','XX-CCC - XX-DDD - NSR');
  `);
  await c.end();
}, 120_000);

afterAll(async () => { await pgContainer?.stop(); });

describe("readDwdmRows", () => {
  it("reads all public.dwdm rows with quoted Ring column", async () => {
    const rows = await readDwdmRows(pgContainer.getConnectionUri());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      device_a_name: "XX-AAA-DWDM-01",
      device_b_name: "XX-BBB-DWDM-01",
      ring: "RING-1",
      snfn_cids: "S1 S2",
      mobily_cids: "M1",
      span_name: "XX-AAA - XX-BBB -  LD",
    });
  });
});
```

**Step 2: Run — expect FAIL (`readDwdmRows` not exported)**

```bash
pnpm --filter ingestor exec vitest run test/dwdm-source.int.test.ts
```

**Step 3: Implement**

```ts
// apps/ingestor/src/source/dwdm.ts
import pg from "pg";
const { Client } = pg;

export type RawDwdmRow = {
  device_a_name: string | null;
  device_a_interface: string | null;
  device_a_ip: string | null;
  device_b_name: string | null;
  device_b_interface: string | null;
  device_b_ip: string | null;
  ring: string | null;
  snfn_cids: string | null;
  mobily_cids: string | null;
  span_name: string | null;
};

/**
 * V1 source: dwdm_view.py:54-60. Note "Ring" is CamelCase + quoted in V1's
 * SQL; we mirror that here. NEVER log results — contains real hostnames.
 */
export async function readDwdmRows(sourceUrl: string): Promise<RawDwdmRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawDwdmRow>(
      `SELECT
         device_a_name,
         device_a_interface,
         device_a_ip,
         device_b_name,
         device_b_interface,
         device_b_ip,
         "Ring" AS ring,
         snfn_cids,
         mobily_cids,
         span_name
       FROM public.dwdm`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
```

**Step 4: Run — expect PASS**

**Step 5: Commit**

```bash
git add apps/ingestor/src/source/dwdm.ts apps/ingestor/test/dwdm-source.int.test.ts
git commit -m "feat(ingestor): readDwdmRows — public.dwdm with quoted Ring (#61)"
```

---

### Task B2: `RawCidRow` + `readCidRows`

**Files:**
- Create: `apps/ingestor/src/source/cid.ts`
- Create: `apps/ingestor/test/cid-source.int.test.ts`

**Step 1: Write failing test** (mirror B1 pattern; seed a 3-row `app_cid` with `protection_cid='nan'`, `''`, and `'P1 P2 P3'`).

**Step 2: Run — expect FAIL**

**Step 3: Implement**

```ts
// apps/ingestor/src/source/cid.ts
import pg from "pg";
const { Client } = pg;

export type RawCidRow = {
  cid: string;
  capacity: string | null;
  source: string | null;
  dest: string | null;
  bandwidth: string | null;
  protection_type: string | null;
  protection_cid: string | null;   // raw — caller parses via cid-parser
  mobily_cid: string | null;
  region: string | null;
};

export async function readCidRows(sourceUrl: string): Promise<RawCidRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawCidRow>(
      `SELECT cid, capacity, source, dest, bandwidth,
              protection_type, protection_cid, mobily_cid, region
         FROM public.app_cid
         WHERE cid IS NOT NULL`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
```

**Step 4: Run — expect PASS**

**Step 5: Commit**

```bash
git add apps/ingestor/src/source/cid.ts apps/ingestor/test/cid-source.int.test.ts
git commit -m "feat(ingestor): readCidRows — app_cid raw rows (#61)"
```

---

## Phase C — DWDM dedup (pure)

### Task C1: `dedupDwdmRows` failing test + implementation

**Files:**
- Create: `apps/ingestor/test/dwdm-dedup.unit.test.ts`
- Modify: `apps/ingestor/src/dedup.ts` (export `DwdmEdge`, `dedupDwdmRows`)

**Step 1: Failing test cases** (must cover):
- Symmetric pair (A→B and B→A rows) → 1 edge
- Self-loop (A=A) → dropped
- NULL `device_b_name` → dropped
- Multi-row anomaly (>2 same canonical pair) → keep first observation, surface count
- Canonical direction is lowercase min/max of names
- `span_name` LD/NSR suffix is stripped on the output edge (uses `stripSpanSuffix`)
- `snfn_cids` and `mobily_cids` parsed via `parseCidList` on the output edge
- `ring` carried verbatim

**Step 2: Run — FAIL**

**Step 3: Implement**

```ts
// apps/ingestor/src/dedup.ts (append)
import { stripSpanSuffix, parseCidList } from "./cid-parser.js";
import type { RawDwdmRow } from "./source/dwdm.js";

export type DwdmEdge = {
  src: string;          // lowercase canonical lesser
  dst: string;          // lowercase canonical greater
  src_interface: string | null;
  dst_interface: string | null;
  ring: string | null;
  snfn_cids: string[];
  mobily_cids: string[];
  span_name: string | null;
};

export type DwdmDedupResult = {
  edges: DwdmEdge[];
  dropped: { null_b: number; self_loop: number; anomaly: number };
};

export function dedupDwdmRows(rows: readonly RawDwdmRow[]): DwdmDedupResult {
  // implementation mirrors dedupLldpRows pattern in this file
  // canonical key: [min(lower(a),lower(b)), max(...)]
  // first-seen wins for properties when multiple rows hit same canonical pair
  // ...
}
```

**Step 4: Run — PASS all dedup cases**

**Step 5: Commit**

```bash
git add apps/ingestor/src/dedup.ts apps/ingestor/test/dwdm-dedup.unit.test.ts
git commit -m "feat(ingestor): dedupDwdmRows — canonical pair + span suffix strip (#61)"
```

---

## Phase D — Writer extension (testcontainer)

### Task D1: 50-row DWDM + CID fixtures

**Files:**
- Create: `apps/ingestor/test/fixtures/dwdm-50.ts`
- Create: `apps/ingestor/test/fixtures/cid-50.ts`

**Step 1**: Hand-craft 50-row DWDM seed mapped onto existing `lldp-50` device names (same `XX-YYY-ROLE-NN` redaction; mix of symmetric pairs, self-loops, null device_b, suffix-bearing span_names, multi-CID `snfn_cids`).

**Step 2**: Hand-craft 50-row CID seed where ~40% of `protection_cid` are `'nan'`, ~30% are single CID, ~30% are space-separated multi-CID. Each `cid` referenced from at least one DWDM `snfn_cids` entry.

**Step 3: Commit**

```bash
git add apps/ingestor/test/fixtures/dwdm-50.ts apps/ingestor/test/fixtures/cid-50.ts
git commit -m "test(ingestor): 50-row DWDM + CID fixtures, redacted hostnames (#61)"
```

---

### Task D2: Writer phase for `:CID` MERGE upsert (rule #28)

**Files:**
- Modify: `apps/ingestor/src/graph/writer.ts`
- Create/Modify: `apps/ingestor/test/dwdm-cid.int.test.ts`

**Step 1: Failing integration test**
- Spin Postgres + Neo4j testcontainers.
- Seed `app_cid` with 50-row fixture.
- Run writer twice (idempotency).
- Assert: count `(:CID)` after run 1 == 50. After run 2 still 50 (MERGE-upsert, rule #28). Properties on a known cid are equal across runs.

**Step 2: Run — FAIL**

**Step 3: Extend `writer.ts` with a new phase that takes `CidProps[]` and runs:**

```cypher
UNWIND $cids AS row
MERGE (c:CID {cid: row.cid})
SET c.capacity        = row.capacity,
    c.source          = row.source,
    c.dest            = row.dest,
    c.bandwidth       = row.bandwidth,
    c.protection_type = row.protection_type,
    c.protection_cids = row.protection_cids,
    c.mobily_cid      = row.mobily_cid,
    c.region          = row.region
```

Add `CREATE CONSTRAINT cid_uniq IF NOT EXISTS FOR (c:CID) REQUIRE c.cid IS UNIQUE;` to the constraint-init block.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/ingestor/src/graph/writer.ts apps/ingestor/test/dwdm-cid.int.test.ts
git commit -m "$(cat <<'EOF'
feat(ingestor): MERGE :CID nodes — contract rule #28 (#61)

V1 used CID.objects.create() which produced duplicates; V2 MERGE-upserts.
Idempotency asserted by running writer twice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D3: Writer phase for `:DWDM_LINK` edges

**Step 1: Failing integration test additions**
- Seed `public.dwdm` with 50-row fixture and `app_cid` with 50-row fixture.
- Run writer once.
- Assert: count `()-[:DWDM_LINK]->()` matches expected (post-dedup count).
- Assert: a known edge has `ring`, `snfn_cids` (array), `mobily_cids` (array), `span_name` (suffix-stripped).
- Assert: symmetric pair collapses to 1 edge.
- Assert: self-loops dropped, null device_b dropped.

**Step 2: Run — FAIL**

**Step 3: Implement** new writer phase after `:CID` phase:

```cypher
UNWIND $edges AS row
MATCH (a:Device {name: row.src_canonical})
MATCH (b:Device {name: row.dst_canonical})
MERGE (a)-[r:DWDM_LINK]->(b)
SET r.ring        = row.ring,
    r.snfn_cids   = row.snfn_cids,
    r.mobily_cids = row.mobily_cids,
    r.span_name   = row.span_name
```

Note: `:Device` nodes already exist from the LLDP phase. If a DWDM row references a device not in LLDP, log to `warnings_json` and skip (do not implicitly create).

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/ingestor/src/graph/writer.ts apps/ingestor/test/dwdm-cid.int.test.ts
git commit -m "feat(ingestor): MERGE :DWDM_LINK edges with parsed CID lists (#61)"
```

---

### Task D4: Wire DWDM + CID into nightly cron

**Files:**
- Modify: `apps/ingestor/src/index.ts`
- Modify: `apps/ingestor/src/cron.ts`
- Modify: `apps/ingestor/test/cron.int.test.ts`

**Step 1: Test that one cron tick now reads DWDM + CID and writes both into the same `ingestion_runs` row.**

**Step 2: Run — FAIL**

**Step 3: Modify `runOnce()` to call `readDwdmRows`, `readCidRows`, `dedupDwdmRows`, parse CID rows, and feed into the writer alongside LLDP. Within ONE Neo4j transaction.**

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/ingestor/src/index.ts apps/ingestor/src/cron.ts apps/ingestor/test/cron.int.test.ts
git commit -m "feat(ingestor): wire DWDM+CID into nightly run (#61)"
```

---

## Phase E — Web library + APIs

### Task E1: `lib/dwdm.ts` — Cypher queries (failing tests first)

**Files:**
- Create: `apps/web/lib/dwdm.ts`
- Create: `apps/web/test/dwdm.int.test.ts`

**Step 1: Failing integration test**
- Testcontainer Neo4j; seed devices + DWDM_LINK edges via the writer (reuse fixtures).
- Test: `listDwdmLinks({device_a:'XX-AAA-DWDM-01'})` returns expected rows.
- Test: `listDwdmLinks({ring:'RING-1'})` filters correctly.
- Test: `getNodeDwdm('XX-AAA-DWDM-01')` returns sub-graph (nodes + edges).
- Test: `getRingDwdm('RING-1')` returns ring sub-graph.

**Step 2: Run — FAIL**

**Step 3: Implement** — mirror existing `lib/topology.ts` pattern. Cypher uses `MATCH (a)-[r:DWDM_LINK]-(b)` (undirected match) and reads `r.ring`, `r.snfn_cids`, `r.mobily_cids`, `r.span_name`. Use `neo4j-coerce.ts` for safe type coercion.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/web/lib/dwdm.ts apps/web/test/dwdm.int.test.ts
git commit -m "feat(web): lib/dwdm.ts — list, by-node, by-ring queries (#61)"
```

---

### Task E2: `GET /api/dwdm` — tabular + CSV export

**Files:**
- Create: `apps/web/app/api/dwdm/route.ts`
- Create: `apps/web/test/api-dwdm.int.test.ts`
- Modify: `apps/web/test/admin-rbac.int.test.ts` (add new routes to `ROUTES` table per CLAUDE.md pitfall — even though `/api/dwdm` is viewer-accessible, the table tracks all auth-bearing routes)

**Step 1: Failing test**: GET with no auth → 401; with viewer role → 200 JSON; `?format=csv` → 200 with `Content-Type: text/csv` and CSV body uses `csvEscape` + `sanitizeFilename`.

**Step 2: Run — FAIL**

**Step 3: Implement** — zod-validate query (`device_a`, `device_b`, `ring`, `span_name`, `format`), gate via existing session check, call `listDwdmLinks`, render JSON or CSV.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/web/app/api/dwdm/route.ts apps/web/test/api-dwdm.int.test.ts apps/web/test/admin-rbac.int.test.ts
git commit -m "feat(web): GET /api/dwdm — tabular + CSV (#61)"
```

---

### Task E3: `GET /api/dwdm/graph` — node + ring sub-graphs

**Files:**
- Create: `apps/web/app/api/dwdm/graph/route.ts`
- Create: `apps/web/test/api-dwdm-graph.int.test.ts`
- Modify: `apps/web/test/admin-rbac.int.test.ts`

**Step 1: Failing test**: `?node=XX-AAA-DWDM-01` returns nodes+edges JSON; `?ring=RING-1` returns ring sub-graph; missing both query params → 400.

**Step 2: Run — FAIL**

**Step 3: Implement** — zod with `.refine` to require exactly one of `node`/`ring`.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/web/app/api/dwdm/graph/route.ts apps/web/test/api-dwdm-graph.int.test.ts apps/web/test/admin-rbac.int.test.ts
git commit -m "feat(web): GET /api/dwdm/graph — node/ring sub-graph (#61)"
```

---

## Phase F — UI pages

### Task F1: `/dwdm` list page

**Files:**
- Create: `apps/web/app/dwdm/page.tsx`
- Create: `apps/web/app/dwdm/_components/DwdmFilterBar.tsx`
- Create: `apps/web/test/dwdm-list.unit.test.tsx`

**Step 1: Failing snapshot/render test** using `renderToStaticMarkup` (per CLAUDE.md vitest pitfall — no jsdom).

**Step 2: Implement** — server component using `listDwdmLinks`, sortable table, "Export CSV" link, filter inputs (device_a, device_b, ring, span_name) wired via search params. Mirror `/devices/page.tsx` style.

**Step 3: Run — PASS**

**Step 4: Update vitest workspace** if any new file extensions need registering (per CLAUDE.md pitfall about `.tsx` unit tests).

**Step 5: Commit**

```bash
git add apps/web/app/dwdm apps/web/test/dwdm-list.unit.test.tsx apps/web/vitest.workspace.ts
git commit -m "feat(web): /dwdm list page with filter + CSV (#61)"
```

---

### Task F2: `/dwdm/[node]/page.tsx` — per-node topology

**Files:**
- Create: `apps/web/app/dwdm/[node]/page.tsx`
- Create: `apps/web/app/dwdm/_components/DwdmCanvas.tsx` (reuse `topology-canvas.tsx` if shape compatible — otherwise mirror)

**Step 1**: Page fetches via `getNodeDwdm(node)` (server-side), passes to client `DwdmCanvas`. Force-dynamic per CLAUDE.md Leaflet/SSR pitfall (vis-network also touches `window` — same `next/dynamic` ssr:false pattern).

**Step 2: Commit**

```bash
git add apps/web/app/dwdm/\[node\] apps/web/app/dwdm/_components/DwdmCanvas.tsx
git commit -m "feat(web): /dwdm/[node] per-node topology page (#61)"
```

---

### Task F3: `/dwdm/ring/[ring]/page.tsx` — ring topology

**Files:**
- Create: `apps/web/app/dwdm/ring/[ring]/page.tsx`

**Step 1**: Mirror F2 but call `getRingDwdm(ring)`.

**Step 2: Commit**

```bash
git add apps/web/app/dwdm/ring
git commit -m "feat(web): /dwdm/ring/[ring] ring topology page (#61)"
```

---

### Task F4: Add "DWDM" to Row-1 nav

**Files:**
- Modify: `apps/web/app/_components/MainNav.tsx` (or wherever nav lives — locate via Serena `find_symbol`)

**Step 1**: Insert "DWDM" link between "Map" and "Analytics" per PRD §238 row-1 ordering.

**Step 2: Commit**

```bash
git add apps/web/app/_components/MainNav.tsx
git commit -m "feat(web): add DWDM to row-1 nav (#61)"
```

---

## Phase G — Documentation

### Task G1: ADR 0005 — DWDM data model

**Files:**
- Create: `docs/decisions/0005-dwdm-data-model.md`

**Content:** Status / Context / Decision / Consequences / V1-mapping table. Document the protection_cid-on-:CID correction relative to PRD §142.

**Commit:**

```bash
git add docs/decisions/0005-dwdm-data-model.md
git commit -m "docs: ADR 0005 — DWDM data model + protection_cid correction (#61)"
```

---

### Task G2: Document `public.dwdm` + `app_cid` in source-schema reference

**Files:**
- Modify: `.claude/references/source-schema.md`

Append `public.dwdm` and re-document `app_cid` with the V1-confirmed columns.

**Commit:**

```bash
git add .claude/references/source-schema.md
git commit -m "docs: document public.dwdm + app_cid columns from V1 (#61)"
```

---

### Task G3: Mark contract rules #19/#20/#21/#27/#28 landed

**Files:**
- Modify: `apps/ingestor/test/contract/README.md`

Flip the 5 rows from `deferred` to `landed`, link to test names in `test/cid-parser.unit.test.ts` and `test/dwdm-cid.int.test.ts`.

**Commit:**

```bash
git add apps/ingestor/test/contract/README.md
git commit -m "docs(contract): rules #19/#20/#21/#27/#28 landed (#61)"
```

---

### Task G4: CLAUDE.md pitfalls — add 1-2 traps surfaced during work

**Files:**
- Modify: `CLAUDE.md`

Likely additions: `"Ring"` is CamelCase + must be quoted in SQL; `protection_cid` lives on `:CID` not `:DWDM_LINK`.

**Commit:**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): DWDM pitfalls — quoted Ring + protection_cid location (#61)"
```

---

## Phase H — Verification

### Task H1: Full type + lint + test suite

```bash
pnpm --filter @tsm/db build
pnpm -r typecheck
pnpm -r lint
pnpm --filter ingestor exec vitest run
pnpm --filter web exec vitest run
pnpm --filter web exec vitest run --project=integration
```

All must pass. If any fail, debug per `superpowers:systematic-debugging`.

### Task H2: Manual smoke (compose stack)

```bash
cp .env.example .env  # fill in source-DB creds
docker compose build
docker compose up -d --wait
docker compose logs -f ingestor    # observe DWDM + CID counts in run summary
```

Visit `https://<host>/dwdm`, `/dwdm/<some-real-node>`, `/dwdm/ring/<some-ring>`. UI renders, no console errors, no SSR crashes.

If a UI feature can't be smoke-tested in this environment, **say so explicitly in the PR body** rather than claim success (per CLAUDE.md global rule).

### Task H3: agent-pipeline review

Invoke `agent-pipeline` skill. Address all blocker findings before merge. Document non-blocker findings in PR body or new issues.

### Task H4: PR

```bash
git push -u origin feat/issue-61-v2-slice-4
gh pr create \
  --title "feat: DWDM ingest + /dwdm pages + CID parser (#61, PR 1/4)" \
  --body "$(cat <<'EOF'
## Summary
- Ingest `public.dwdm` -> `:DWDM_LINK` edges with `ring`, `snfn_cids[]`, `mobily_cids[]`, `span_name` (LD/NSR-stripped).
- Ingest `app_cid` -> `:CID` nodes (MERGE-upsert) with parsed `protection_cids[]`.
- New pages: `/dwdm`, `/dwdm/[node]`, `/dwdm/ring/[ring]`. New APIs: `/api/dwdm`, `/api/dwdm/graph`.
- Lands contract rules #19, #20, #21, #27, #28 (deferred from #59).
- ADR 0005 documents the protection_cid-on-:CID correction (vs PRD §142 wording).

## Refs
Refs #61 (PR 1 of 4 — covers ACs 1-4; PR 2 will add SNFN overlay covering AC 5).

## Acceptance Criteria covered (issue #61)
- [x] AC 1: DWDM source-read stage exists -> apps/ingestor/src/source/dwdm.ts + test/dwdm-source.int.test.ts
- [x] AC 2: :DWDM_LINK edges written with all properties; protection_cid lives on :CID per V1 ground truth (see ADR 0005)
- [x] AC 3: /dwdm list with filter + CSV
- [x] AC 4: /dwdm/[node] + /dwdm/ring/[ring] pages
- [ ] ACs 5-10 deferred to PRs 2/3/4 of #61

## Test Plan
- [ ] `pnpm -r typecheck`
- [ ] `pnpm --filter ingestor exec vitest run`
- [ ] `pnpm --filter web exec vitest run`
- [ ] Manual: /dwdm UI smoke against compose stack

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Task H5: Watch CI, squash-merge, update issue

Use `gh pr checks <N> --watch`, then `gh pr merge <N> --squash --delete-branch`. Comment summary on #61. Issue stays open (only PR 4 closes).

---

## Cross-cutting reminders

- **Every commit references `(#61)`.**
- **Never log source DB rows** — real production data per CLAUDE.md.
- **Never hardcode credentials** — use `.env` flow only.
- **`.env.example` already carries an uncommitted ISIS block from #67** — leave untouched, do not stage.
- **Rebuild `@tsm/db`** before any cross-workspace typecheck if you touched it (you shouldn't in PR 1).
- **Update `apps/web/test/admin-rbac.int.test.ts` `ROUTES` table** for any new auth-bearing route.
- **Update `apps/web/vitest.workspace.ts`** before adding any `.tsx` unit test.
- **Three-strike rule:** if a task fails 3 times, STOP and ask human.
