# Issue #60 PR 1 — Weighted Graph + Device-to-Device Path-Trace

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a weighted shortest-path resolver in `apps/web/lib/path.ts`, a device-to-device mode (`to` param) with a same-level corridor predicate, and the UI plumbing (banner + per-hop weight column, `/topology?from=A&to=B` rendering A→B) — all without introducing an APOC or GDS dependency. PR 2 (separate issue) will populate the `weight` property from ClickHouse; PR 1 ships with an algorithm that degrades gracefully to hop-count for every edge because no edges are weighted yet.

**Architecture:** Pure-Cypher weighted shortest-path using `reduce(..)` over `shortestPath` candidates, `ORDER BY` total weight then hop count. Graph is ~250k edges; `*..15` hop cap bounds fan-out. A single driver call returns the chosen path plus a `weighted: boolean` flag; UI reads the flag and renders either hop-count or weight styling. Same-level device-to-device relaxes the monotonic-level predicate to a **corridor** (`level ∈ [min(src,tgt).level − 1, max(src,tgt).level + 1]`) to prevent zig-zag-through-core paths. ADR 0004 documents the edge-match key (canonical unordered `(device_name, interface)` pair both sides), the `weight_source='observed'|null` convention (null implies hop fallback), and explicit rejection of APOC/GDS.

**Tech Stack:** Next.js 14 (App Router, server components), TypeScript, Zod, Neo4j 5 Community (no plugins), Vitest + testcontainers for integration tests, Playwright for E2E.

**Scope boundary (do not touch in PR 1):**
- ClickHouse ingestion stage — PR 2.
- Admin freshness surface — PR 2.
- Any `weight_observed_at` / `weight_vendor` edge properties — PR 2 (schema evolves when data arrives).
- Existing `:CONNECTS_TO { a_if, b_if, status, updated_at }` is untouched except for the `weight` property that already exists per PRD line 262.

**Acceptance criteria from issue #60 closed by this PR:** 2, 3, 4, 5, 6, 7, 8, 9, 10. Criterion 1 (ingest stage) is PR 2.

---

## Conventions

- **Commit trailer**: every commit body ends with `#60`.
- **Commit prefixes**: `test:` (RED), `feat:` / `fix:` (GREEN), `refactor:` (neutral), `docs:` (ADR/plan).
- **Branch**: `feat/issue-60-weighted-graph` (already created).
- **Integration tests**: extend `apps/web/test/path.int.test.ts` and `apps/web/test/topology.int.test.ts`; do NOT spin up a second container. Mirror the existing `seed(driver)` pattern — one container, many `it()` blocks.
- **No DB mocks** — per `CLAUDE.md` global feedback rule.
- **`MAX_PATH_HOPS` interpolation pitfall** (`CLAUDE.md`): never pass as a parameter; Zod-validate + interpolate.

---

## Task 1 — ADR 0004 scaffold

**Files:**
- Create: `docs/decisions/0004-isis-weight-policy.md`

**Step 1: Write the ADR skeleton (full body fills in at Task 13)**

```markdown
# 0004 — ISIS weight policy and pure-Cypher shortest-path

**Status:** Proposed (PR 1 of issue #60)
**Date:** 2026-04-25
**Supersedes:** —

## Context
(filled in Task 13)

## Decision
(filled in Task 13)

## Consequences
(filled in Task 13)
```

**Step 2: Commit**

```bash
git add docs/decisions/0004-isis-weight-policy.md
git commit -m "docs: scaffold ADR 0004 ISIS weight policy (#60)"
```

---

## Task 2 — Schema extension: `weight`, `weighted`, `to`

**Files:**
- Modify: `apps/web/lib/path.ts:51-90` (Hop + PathResponse + PathQuery)

**Step 1: Read the current shapes**

Re-read `apps/web/lib/path.ts:51-90` to confirm exact line anchors.

**Step 2: Extend `Hop` with optional `weight`**

Edit `apps/web/lib/path.ts:51-59`:

```ts
export const Hop = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
  in_if: z.string().nullable(),
  out_if: z.string().nullable(),
  // Edge weight ENTERING this hop (null for first hop and whenever the
  // inbound edge has no observed ISIS cost). PR 1 always emits null until
  // PR 2 populates :CONNECTS_TO.weight from ClickHouse.
  edge_weight_in: z.number().nullable(),
});
```

**Step 3: Extend `PathResponse` "ok" with `weighted`**

Edit `apps/web/lib/path.ts:78-89`:

```ts
export const PathResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    length: z.number(),
    // True iff every edge on the chosen path had a non-null weight
    // (weighted Dijkstra ran); false iff hop-count fallback fired.
    weighted: z.boolean(),
    total_weight: z.number().nullable(),
    hops: z.array(Hop),
  }),
  z.object({
    status: z.literal("no_path"),
    reason: NoPathReasonSchema,
    unreached_at: DeviceRef.nullable(),
  }),
]);
```

**Step 4: Extend `PathQuery` with optional `to`**

Replace `apps/web/lib/path.ts:12-43` with a two-field form. `from` keeps the existing `kind:value` regex; `to` is optional, same regex, must be `device:<name>` (services are not valid endpoints).

```ts
const FROM_RE = /^(device|service):([\s\S]+)$/;
const TO_RE = /^device:([\s\S]+)$/;

export const PathQuery = z
  .object({ from: z.string(), to: z.string().optional() })
  .transform((o, ctx) => {
    const fm = FROM_RE.exec(o.from);
    if (!fm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "from must be 'device:<name>' or 'service:<cid>'" });
      return z.NEVER;
    }
    const kind = fm[1] as "device" | "service";
    const value = fm[2]!.trim();
    if (value.length === 0 || value.length > 200) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value invalid" });
      return z.NEVER;
    }
    let to: { value: string } | undefined;
    if (o.to !== undefined) {
      const tm = TO_RE.exec(o.to);
      if (!tm) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to must be 'device:<name>'" });
        return z.NEVER;
      }
      const tv = tm[1]!.trim();
      if (tv.length === 0 || tv.length > 200) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to value invalid" });
        return z.NEVER;
      }
      to = { value: tv };
    }
    return { kind, value, to };
  });
export type PathQuery = z.infer<typeof PathQuery>;
```

**Step 5: Typecheck (existing callers must still compile)**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: FAIL — `runPath` implementation and `pickInOut` now return the wrong `Hop` shape (missing `edge_weight_in`). Fix surfaces in Tasks 4 and 6.

**Step 6: Commit (schema only, red state expected)**

```bash
git add apps/web/lib/path.ts
git commit -m "feat: extend Hop/PathResponse/PathQuery for weighted + to= (#60)"
```

---

## Task 3 — RED: weighted path picks min-weight over min-hop

**Files:**
- Modify: `apps/web/test/path.int.test.ts` (append new `it()` block)

**Step 1: Locate the seed() helper**

Read `apps/web/test/path.int.test.ts:1-60`. Add a second seed helper `seedWeighted(driver)` alongside (do not mutate the original — other tests rely on it).

**Step 2: Add seed helper**

Append (anywhere above the `describe` block in the same file):

```ts
async function seedWeighted(driver: Driver) {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (n) DETACH DELETE n`, // isolate weighted fixtures from the main seed
    );
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    await session.run(
      "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
    );
    // Two routes from A (level 2) to Core (level 1):
    //   A -[w=10]-> B -[w=10]-> Core   (2 hops, total weight 20)
    //   A -[w=1]->  C -[w=1]->  D -[w=1]-> Core   (3 hops, total weight 3)
    // Min-hop chooses the 2-hop route; min-weight must choose the 3-hop route.
    await session.run(
      `CREATE
        (a:Device:UPE  {name:'A',     role:'UPE',  level:2, site:'S', domain:'D'}),
        (b:Device:UPE  {name:'B',     role:'UPE',  level:2, site:'S', domain:'D'}),
        (c:Device:UPE  {name:'C',     role:'UPE',  level:2, site:'S', domain:'D'}),
        (d:Device:UPE  {name:'D',     role:'UPE',  level:2, site:'S', domain:'D'}),
        (core:Device:CORE {name:'Core', role:'CORE', level:1, site:'S', domain:'D'}),
        (a)-[:CONNECTS_TO {a_if:'a-b', b_if:'b-a', weight: 10.0}]->(b),
        (b)-[:CONNECTS_TO {a_if:'b-core', b_if:'core-b', weight: 10.0}]->(core),
        (a)-[:CONNECTS_TO {a_if:'a-c', b_if:'c-a', weight: 1.0}]->(c),
        (c)-[:CONNECTS_TO {a_if:'c-d', b_if:'d-c', weight: 1.0}]->(d),
        (d)-[:CONNECTS_TO {a_if:'d-core', b_if:'core-d', weight: 1.0}]->(core)
      `,
    );
  } finally {
    await session.close();
  }
}
```

**Step 3: Add failing `it()`**

Inside the existing `describe("runPath (integration)", ...)` block, append:

```ts
it("picks min-weight path over min-hop when all edges are weighted", async () => {
  await seedWeighted(adminDriver);
  const { runPath } = await import("@/lib/path");
  const res = await runPath({ kind: "device", value: "A" });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") return;
  expect(res.weighted).toBe(true);
  expect(res.total_weight).toBe(3);
  expect(res.hops.map((h) => h.name)).toEqual(["A", "C", "D", "Core"]);
  // First hop has no inbound edge -> null; subsequent hops all w=1.
  expect(res.hops.map((h) => h.edge_weight_in)).toEqual([null, 1, 1, 1]);
});

it("falls back to min-hop when any edge on the candidate set is unweighted", async () => {
  // Same topology as seedWeighted but strip one weight on the 3-hop route.
  await seedWeighted(adminDriver);
  const s = adminDriver.session();
  try {
    await s.run(`MATCH ()-[r:CONNECTS_TO {a_if:'c-d'}]-() SET r.weight = null`);
  } finally {
    await s.close();
  }
  const { runPath } = await import("@/lib/path");
  const res = await runPath({ kind: "device", value: "A" });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") return;
  expect(res.weighted).toBe(false);
  expect(res.total_weight).toBeNull();
  // Hop count preferred -> 2-hop A->B->Core path.
  expect(res.hops.map((h) => h.name)).toEqual(["A", "B", "Core"]);
  expect(res.hops.map((h) => h.edge_weight_in)).toEqual([null, null, null]);
});
```

**Step 4: Run and confirm failure**

Run: `pnpm --filter web test:int -t "min-weight path"`
Expected: FAIL — either schema mismatch or algorithm picks 2-hop route.

**Step 5: Commit RED**

```bash
git add apps/web/test/path.int.test.ts
git commit -m "test: add weighted vs hop-count path expectations (#60)"
```

---

## Task 4 — GREEN: weighted shortest-path in `runPath`

**Files:**
- Modify: `apps/web/lib/path.ts:225-261` (weighted Cypher)
- Modify: `apps/web/lib/path.ts:144-162` (extend `pickInOut` to return `edge_weight_in`)

**Step 1: Add weight helper**

Insert above `pickInOut` in `apps/web/lib/path.ts`:

```ts
function pickInboundWeight(
  node: PathNode,
  prev: PathEdge | null,
): number | null {
  if (!prev) return null;
  return prev.weight;
}
```

**Step 2: Extend `PathEdge` type**

Modify `apps/web/lib/path.ts:108-113`:

```ts
type PathEdge = {
  a: string;
  b: string;
  a_if: string | null;
  b_if: string | null;
  weight: number | null;
};
```

And `edgeToPathEdge` (`apps/web/lib/path.ts:125-132`):

```ts
function edgeToPathEdge(e: Record<string, unknown>): PathEdge {
  return {
    a: String(e.a),
    b: String(e.b),
    a_if: toStrOrNull(e.a_if),
    b_if: toStrOrNull(e.b_if),
    weight: e.weight == null ? null : toNum(e.weight),
  };
}
```

**Step 3: Replace the Cypher block at lines 227-245 with a weighted two-phase query**

```ts
// 2. Enumerate shortestPath candidates, compute weighted total per candidate
//    (null if ANY edge lacks weight), then prefer min-total-weight when all
//    candidates are fully weighted, else min-hop. Traversal is undirected.
const pathRes = await session.run(
  `MATCH (start:Device {name: $startName})
   MATCH (core:Device) WHERE core.level = 1
   WITH start, core
   MATCH p = shortestPath((start)-[:CONNECTS_TO*1..${MAX_PATH_HOPS}]-(core))
   WHERE ALL(i IN range(0, length(p) - 1)
             WHERE (nodes(p)[i]).level >= (nodes(p)[i + 1]).level)
   WITH p,
        [r IN relationships(p) | r.weight] AS ws,
        length(p) AS hops
   WITH p, hops,
        CASE WHEN any(w IN ws WHERE w IS NULL)
             THEN null
             ELSE reduce(t = 0.0, w IN ws | t + w)
        END AS total_weight
   RETURN [n IN nodes(p) | n { .name, .role, .level, .site, .domain }] AS pathNodes,
          [r IN relationships(p) | {
             a: startNode(r).name,
             b: endNode(r).name,
             a_if: r.a_if,
             b_if: r.b_if,
             weight: r.weight
          }] AS pathEdges,
          total_weight,
          hops
   ORDER BY
     // Sort null totals last so weighted candidates win when any exists.
     CASE WHEN total_weight IS NULL THEN 1 ELSE 0 END ASC,
     total_weight ASC,
     hops ASC
   LIMIT 1`,
  { startName },
);
```

**Step 4: Update the `if (pathRes.records.length > 0)` block**

Replace lines 247-262 with:

```ts
if (pathRes.records.length > 0) {
  const rec = pathRes.records[0]!;
  const pathNodes = (rec.get("pathNodes") as Array<Record<string, unknown>>).map(nodeToPathNode);
  const pathEdges = (rec.get("pathEdges") as Array<Record<string, unknown>>).map(edgeToPathEdge);
  const totalWeightRaw = rec.get("total_weight");
  const totalWeight = totalWeightRaw == null ? null : toNum(totalWeightRaw);
  const weighted = totalWeight != null;
  const hops: Hop[] = pathNodes.map((n, i) => {
    const prev = i > 0 ? pathEdges[i - 1]! : null;
    const next = i < pathEdges.length ? pathEdges[i]! : null;
    const { in_if, out_if } = pickInOut(n, prev, next);
    return {
      ...n,
      in_if,
      out_if,
      edge_weight_in: weighted ? pickInboundWeight(n, prev) : null,
    };
  });
  return {
    status: "ok",
    length: pathEdges.length,
    weighted,
    total_weight: totalWeight,
    hops,
  };
}
```

**Step 5: Fix the zero-hop Core short-circuit**

At `apps/web/lib/path.ts:186-192`, the early-return needs the new fields:

```ts
if (startDev.level === 1) {
  return {
    status: "ok",
    length: 0,
    weighted: true,        // 0-length path is vacuously weighted.
    total_weight: 0,
    hops: [{ ...startDev, in_if: null, out_if: null, edge_weight_in: null }],
  };
}
```

**Step 6: Run weighted tests**

Run: `pnpm --filter web test:int -t "path"`
Expected: PASS for both new cases + all pre-existing path tests.

**Step 7: Typecheck + lint**

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web lint
```
Expected: clean.

**Step 8: Commit GREEN**

```bash
git add apps/web/lib/path.ts
git commit -m "feat: weighted shortest-path with hop-count fallback (#60)

root cause: path.ts used monotonic shortestPath with no weight awareness;
replaces with reduce()-aggregated total_weight and null-last ordering so
weighted candidates win iff every edge on the path is weighted."
```

---

## Task 5 — RED: device-to-device same-level corridor

**Files:**
- Modify: `apps/web/test/path.int.test.ts` (append)

**Step 1: Add device-to-device fixture + test**

Append inside the same `describe` block:

```ts
async function seedDeviceToDevice(driver: Driver) {
  const session = driver.session();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    await session.run(
      "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
    );
    // Two level-2 UPEs connected through a shared level-3 CSG.
    // A monotonic-only predicate would force the path through core.
    // Corridor predicate [min-1, max+1] = [1, 3] must keep the detour via CSG valid.
    await session.run(
      `CREATE
        (a:Device:UPE {name:'A', role:'UPE', level:2, site:'S', domain:'D'}),
        (b:Device:UPE {name:'B', role:'UPE', level:2, site:'S', domain:'D'}),
        (mid:Device:CSG {name:'Mid', role:'CSG', level:3, site:'S', domain:'D'}),
        (c:Device:CORE {name:'Core', role:'CORE', level:1, site:'S', domain:'D'}),
        (a)-[:CONNECTS_TO {a_if:'a-mid', b_if:'mid-a'}]->(mid),
        (mid)-[:CONNECTS_TO {a_if:'mid-b', b_if:'b-mid'}]->(b),
        (a)-[:CONNECTS_TO {a_if:'a-core', b_if:'core-a'}]->(c),
        (b)-[:CONNECTS_TO {a_if:'b-core', b_if:'core-b'}]->(c)
      `,
    );
  } finally {
    await session.close();
  }
}

it("device-to-device same-level corridor returns shortest A->Mid->B path", async () => {
  await seedDeviceToDevice(adminDriver);
  const { runPath } = await import("@/lib/path");
  const res = await runPath({ kind: "device", value: "A", to: { value: "B" } });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") return;
  expect(res.hops.map((h) => h.name)).toEqual(["A", "Mid", "B"]);
  expect(res.length).toBe(2);
});

it("device-to-device across levels uses monotonic predicate", async () => {
  await seedDeviceToDevice(adminDriver);
  const { runPath } = await import("@/lib/path");
  // A (level 2) -> Core (level 1): corridor collapses to the existing monotonic rule.
  const res = await runPath({ kind: "device", value: "A", to: { value: "Core" } });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") return;
  expect(res.hops.map((h) => h.name)).toEqual(["A", "Core"]);
});
```

**Step 2: Run and confirm failure**

Run: `pnpm --filter web test:int -t "device-to-device"`
Expected: FAIL — `runPath` doesn't accept `to` yet or returns wrong path.

**Step 3: Commit RED**

```bash
git add apps/web/test/path.int.test.ts
git commit -m "test: add device-to-device corridor expectations (#60)"
```

---

## Task 6 — GREEN: implement device-to-device with corridor predicate

**Files:**
- Modify: `apps/web/lib/path.ts` — new `runDeviceToDevice` branch + corridor Cypher

**Step 1: Branch early in `runPath`**

Right after the start-resolution block (after `apps/web/lib/path.ts:223`), before the Core-search block, insert:

```ts
// 2a. Device-to-device mode: corridor predicate
//     level ∈ [min(src,tgt)-1, max(src,tgt)+1].
//     Weighted preference identical to the to-core case.
if (q.to !== undefined) {
  // Resolve target level once.
  const tgtRes = await session.run(
    `MATCH (t:Device {name: $name})
     RETURN t { .name, .role, .level, .site, .domain } AS node`,
    { name: q.to.value },
  );
  if (tgtRes.records.length === 0) {
    return { status: "no_path", reason: "start_not_found", unreached_at: null };
  }
  const tgtNode = tgtRes.records[0]!.get("node") as Record<string, unknown>;
  const tgtLevel = toNum(tgtNode.level ?? 0);
  const srcLevel = startDev!.level;
  const loLevel = Math.min(srcLevel, tgtLevel) - 1;
  const hiLevel = Math.max(srcLevel, tgtLevel) + 1;

  const d2dRes = await session.run(
    `MATCH (start:Device {name: $startName}), (tgt:Device {name: $tgtName})
     MATCH p = shortestPath((start)-[:CONNECTS_TO*1..${MAX_PATH_HOPS}]-(tgt))
     WHERE ALL(n IN nodes(p) WHERE n.level >= $loLevel AND n.level <= $hiLevel)
     WITH p,
          [r IN relationships(p) | r.weight] AS ws,
          length(p) AS hops
     WITH p, hops,
          CASE WHEN any(w IN ws WHERE w IS NULL)
               THEN null
               ELSE reduce(t = 0.0, w IN ws | t + w)
          END AS total_weight
     RETURN [n IN nodes(p) | n { .name, .role, .level, .site, .domain }] AS pathNodes,
            [r IN relationships(p) | {
               a: startNode(r).name, b: endNode(r).name,
               a_if: r.a_if, b_if: r.b_if, weight: r.weight
            }] AS pathEdges,
            total_weight, hops
     ORDER BY
       CASE WHEN total_weight IS NULL THEN 1 ELSE 0 END ASC,
       total_weight ASC,
       hops ASC
     LIMIT 1`,
    { startName, tgtName: q.to.value, loLevel, hiLevel },
  );

  if (d2dRes.records.length === 0) {
    return { status: "no_path", reason: "island", unreached_at: deviceRefFrom(tgtNode) };
  }
  const rec = d2dRes.records[0]!;
  // Same materialization as the to-core branch — extract to a helper if
  // a third call site appears; do not prematurely abstract now.
  const pathNodes = (rec.get("pathNodes") as Array<Record<string, unknown>>).map(nodeToPathNode);
  const pathEdges = (rec.get("pathEdges") as Array<Record<string, unknown>>).map(edgeToPathEdge);
  const totalWeightRaw = rec.get("total_weight");
  const totalWeight = totalWeightRaw == null ? null : toNum(totalWeightRaw);
  const weighted = totalWeight != null;
  const hops: Hop[] = pathNodes.map((n, i) => {
    const prev = i > 0 ? pathEdges[i - 1]! : null;
    const next = i < pathEdges.length ? pathEdges[i]! : null;
    const { in_if, out_if } = pickInOut(n, prev, next);
    return {
      ...n,
      in_if, out_if,
      edge_weight_in: weighted ? pickInboundWeight(n, prev) : null,
    };
  });
  return {
    status: "ok",
    length: pathEdges.length,
    weighted,
    total_weight: totalWeight,
    hops,
  };
}
```

**Step 2: Run device-to-device tests**

Run: `pnpm --filter web test:int -t "device-to-device"`
Expected: PASS.

**Step 3: Run full path test file**

Run: `pnpm --filter web test:int apps/web/test/path.int.test.ts`
Expected: all pre-existing + new tests PASS.

**Step 4: Commit GREEN**

```bash
git add apps/web/lib/path.ts
git commit -m "feat: device-to-device path-trace with corridor predicate (#60)

Corridor predicate: level in [min(src,tgt)-1, max(src,tgt)+1]. For
same-level endpoints this admits one-level detours above and below
(avoids zig-zag through core) while still bounding the search.
For cross-level endpoints the corridor collapses into the existing
monotonic behaviour."
```

---

## Task 7 — RED: PathView banner + weight column

**Files:**
- Create: `apps/web/test/path-view.test.tsx`

**Step 1: Confirm vitest workspace includes `.tsx` unit tests**

Per `CLAUDE.md` pitfall, verify `apps/web/vitest.workspace.ts` covers `.test.{ts,tsx}` with `esbuild: { jsx: "automatic" }` in the unit project. If not, extend it in this same step (include globs + esbuild config).

Grep: `grep -n 'jsx\|tsx\|esbuild' apps/web/vitest.workspace.ts`
If missing, add. Commit in this task.

**Step 2: Write the failing component tests**

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathView } from "@/app/_components/path-view";
import type { PathResponse } from "@/lib/path";

const weighted: PathResponse = {
  status: "ok",
  length: 2,
  weighted: true,
  total_weight: 20,
  hops: [
    { name: "A", role: "UPE", level: 2, site: null, domain: null, in_if: null, out_if: "a-b", edge_weight_in: null },
    { name: "B", role: "UPE", level: 2, site: null, domain: null, in_if: "b-a", out_if: "b-c", edge_weight_in: 10 },
    { name: "C", role: "CORE", level: 1, site: null, domain: null, in_if: "c-b", out_if: null, edge_weight_in: 10 },
  ],
};

const unweighted: PathResponse = {
  ...weighted,
  weighted: false,
  total_weight: null,
  hops: weighted.hops.map((h) => ({ ...h, edge_weight_in: null })),
};

describe("PathView", () => {
  it("renders per-hop weight badges when weighted", () => {
    const html = renderToStaticMarkup(<PathView data={weighted} />);
    expect(html).toContain('data-testid="path-weight-badge"');
    expect(html).toContain(">10<"); // inbound weight on B and C
    expect(html).toContain('data-testid="path-total-weight"');
    expect(html).toContain(">20<"); // total
    expect(html).not.toContain('data-testid="path-unweighted-banner"');
  });

  it("renders the 'unweighted' banner and omits weight badges when unweighted", () => {
    const html = renderToStaticMarkup(<PathView data={unweighted} />);
    expect(html).toContain('data-testid="path-unweighted-banner"');
    expect(html).not.toContain('data-testid="path-weight-badge"');
    expect(html).not.toContain('data-testid="path-total-weight"');
  });
});
```

**Step 3: Run and confirm failure**

Run: `pnpm --filter web test apps/web/test/path-view.test.tsx`
Expected: FAIL — testids don't exist yet.

**Step 4: Commit RED**

```bash
git add apps/web/test/path-view.test.tsx apps/web/vitest.workspace.ts
git commit -m "test: PathView banner + weight-badge rendering (#60)"
```

---

## Task 8 — GREEN: PathView banner + weight UI

**Files:**
- Modify: `apps/web/app/_components/path-view.tsx`

**Step 1: Add a banner + weight badge**

Add a top-of-component banner and extend `Connector` to show weight:

```tsx
function UnweightedBanner() {
  return (
    <div
      data-testid="path-unweighted-banner"
      role="note"
      aria-label="Unweighted path"
      className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      This path includes hops without observed ISIS cost.
      Traversal order reflects hop count, not weighted cost.
    </div>
  );
}

function WeightBadge({ value }: { value: number }) {
  return (
    <span
      data-testid="path-weight-badge"
      className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700"
      aria-label={`ISIS cost ${value}`}
    >
      {value}
    </span>
  );
}
```

Update `Connector` to optionally accept + render the weight entering the next hop:

```tsx
function Connector({
  out_if, in_if, weight,
}: { out_if: string | null; in_if: string | null; weight: number | null }) {
  return (
    <div className="ml-4 flex items-center gap-2 py-1 text-xs text-slate-500" data-testid="path-connector">
      <span className="font-mono">{out_if ?? "—"}</span>
      <span aria-hidden="true">→</span>
      <span className="font-mono">{in_if ?? "—"}</span>
      {weight !== null && <WeightBadge value={weight} />}
    </div>
  );
}
```

Update the `PathView` rendering path:

```tsx
export function PathView({ data }: { data: PathResponse }) {
  if (data.status === "no_path") {
    return <NoPathPanel reason={data.reason} unreached_at={data.unreached_at} />;
  }
  const { hops, weighted, total_weight } = data;
  return (
    <div>
      {!weighted && <UnweightedBanner />}
      {weighted && total_weight !== null && (
        <div className="mb-3 text-sm text-slate-600">
          Total ISIS cost: <span data-testid="path-total-weight" className="font-mono">{total_weight}</span>
        </div>
      )}
      <ol className="space-y-0" data-testid="path-view" aria-label="Path trace hops">
        {hops.map((hop, i) => {
          const next = hops[i + 1];
          return (
            <li key={`${hop.name}-${i}`}>
              <HopRow hop={hop} />
              {next && (
                <Connector
                  out_if={hop.out_if}
                  in_if={next.in_if}
                  weight={weighted ? next.edge_weight_in : null}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
```

**Step 2: Run tests**

Run: `pnpm --filter web test apps/web/test/path-view.test.tsx`
Expected: PASS.

**Step 3: Typecheck**

```bash
pnpm --filter web exec tsc --noEmit
```
Expected: clean.

**Step 4: Commit GREEN**

```bash
git add apps/web/app/_components/path-view.tsx
git commit -m "feat: PathView unweighted-banner + per-hop weight badge (#60)"
```

---

## Task 9 — RED: Topology `to=` renders A→B

**Files:**
- Modify: `apps/web/test/topology.int.test.ts` (or create if missing)

**Step 1: Discover existing topology integration test file**

Run: `ls apps/web/test/topology*`
If no integration file exists, model the new one on `apps/web/test/path.int.test.ts` (testcontainer + seed + dynamic imports).

**Step 2: Add failing test**

```ts
it("path mode with from=A&to=B renders the A->B path not A->core", async () => {
  await seedDeviceToDevice(adminDriver);
  const { runTopologyPath } = await import("@/lib/topology");
  const graph = await runTopologyPath({
    from: { kind: "device", value: "A" },
    to: { kind: "device", value: "B" },
  });
  const names = graph.nodes.map((n) => n.id).sort();
  expect(names).toEqual(["A", "B", "Mid"]);
  expect(graph.edges.length).toBe(2);
});
```

`runTopologyPath` does not yet exist — Task 11 creates it.

**Step 3: Run and confirm failure**

Run: `pnpm --filter web test:int -t "renders the A->B path"`
Expected: FAIL — `runTopologyPath is not a function`.

**Step 4: Commit RED**

```bash
git add apps/web/test/topology.int.test.ts
git commit -m "test: topology /?from=A&to=B renders A->B path (#60)"
```

---

## Task 10 — GREEN: `runTopologyPath` in `lib/topology.ts`

**Files:**
- Modify: `apps/web/lib/topology.ts`

**Step 1: Add resolver that delegates to `runPath`**

Append to `apps/web/lib/topology.ts`:

```ts
import { runPath } from "@/lib/path";

export type TopologyPathInput = {
  from: { kind: "device" | "service"; value: string };
  to: { kind: "device"; value: string };
};

export async function runTopologyPath(
  input: TopologyPathInput,
): Promise<{ nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] }> {
  const path = await runPath({
    kind: input.from.kind,
    value: input.from.value,
    to: { value: input.to.value },
  });
  if (path.status !== "ok") {
    return { nodes: [], edges: [] };
  }
  return hopsToGraphDTO(path.hops);
}
```

**Step 2: Run test**

Run: `pnpm --filter web test:int -t "renders the A->B path"`
Expected: PASS.

**Step 3: Commit GREEN**

```bash
git add apps/web/lib/topology.ts
git commit -m "feat: runTopologyPath for device-to-device topology (#60)"
```

---

## Task 11 — Wire `/topology` page to honour `to`

**Files:**
- Modify: `apps/web/app/topology/page.tsx:169-186` (drop advisory branch; call `runTopologyPath` when both `from` and `to` are present)

**Step 1: Replace the path-mode branch**

Delete lines that emit the `"MVP: 'to' is advisory"` note. Replace with:

```ts
if (query.mode === "path") {
  const g = await runTopologyPath({
    from: { kind: query.from.kind, value: query.from.value },
    to:   { kind: "device", value: query.to.value },
  });
  if (g.nodes.length === 0) {
    note = `No path from ${query.from.kind}:${query.from.value} to device:${query.to.value}.`;
  } else {
    graph = g;
  }
}
```

Remove the old `runPath` import for the path branch if it becomes unused (check `rg "runPath" apps/web/app/topology/page.tsx`). `runTopologyPath` must be added to the topology import list at the top of the file.

**Step 2: Grep for orphaned `advisory` strings**

```bash
rg "advisory" apps/web/
```
Expected: no matches in production code (tests may reference the old copy — update any).

**Step 3: Run all web tests**

```bash
pnpm --filter web test
pnpm --filter web test:int
```
Expected: all PASS.

**Step 4: Commit**

```bash
git add apps/web/app/topology/page.tsx apps/web/lib/topology.ts
git commit -m "feat: /topology?to= renders device-to-device path (#60)"
```

---

## Task 12 — E2E: `/topology?from=A&to=B` two-endpoint render

**Files:**
- Modify or create: `apps/web/e2e/topology.spec.ts`

**Step 1: Locate existing E2E seed fixture**

Run: `ls apps/web/e2e/ && grep -rn "E2E-" apps/web/e2e/`
Identify the fixture-seeding pattern (per CLAUDE.md `E2E-*` prefix convention).

**Step 2: Add spec**

```ts
import { test, expect } from "@playwright/test";

test("topology with from+to renders A->B path", async ({ page }) => {
  await page.goto("/topology?from=device:E2E-UPE-A&to=device:E2E-UPE-B");
  await page.waitForSelector('[data-testid="topology-canvas"]');
  // Both endpoints must be on the canvas; B must NOT be absent just because
  // it is not a core.
  await expect(page.locator('[data-testid="topology-node"]', { hasText: "E2E-UPE-A" })).toBeVisible();
  await expect(page.locator('[data-testid="topology-node"]', { hasText: "E2E-UPE-B" })).toBeVisible();
  // Advisory copy is gone.
  await expect(page.getByText(/advisory/i)).toHaveCount(0);
});
```

**Step 3: Run**

Run: `pnpm --filter web test:e2e -g "renders A->B"`
Expected: PASS (may require seed update with an E2E-UPE-A/E2E-UPE-B fixture — extend the existing seed in the same commit).

**Step 4: Commit**

```bash
git add apps/web/e2e/topology.spec.ts apps/web/test-support/*seed*
git commit -m "test(e2e): topology /?from=...&to=... two-endpoint render (#60)"
```

---

## Task 13 — Flesh out ADR 0004

**Files:**
- Modify: `docs/decisions/0004-isis-weight-policy.md`

**Step 1: Write the full ADR body**

```markdown
# 0004 — ISIS weight policy and pure-Cypher shortest-path

**Status:** Accepted (PR 1 of issue #60)
**Date:** 2026-04-25
**Supersedes:** —

## Context

Issue #60 asks path-trace to honour ISIS edge cost and to support
device-to-device queries. V1 used NetworkX Dijkstra over a pickled
in-memory graph; V2 stores the graph in Neo4j and resolves paths
inside the request cycle.

Data investigation (April 2026) found:

- `lldp_data.isis_cost` in ClickHouse currently carries **Huawei-only**
  weights, ~815k append rows, last refreshed **2025-02-14**. The upstream
  pipeline is expected to be repaired; until then, coverage is partial.
- `app_lldp` has no bandwidth column. Interface names that encode
  bandwidth (GigabitEthernet / TenGigE / HundredGigE / ge-/xe-/et-)
  account for ~6% of rows. Deriving weight from the name is not viable.
- Neo4j 5 Community has no plugins installed. `apoc.algo.dijkstra` lives
  in APOC Extended (not Core), and GDS requires graph projection. At
  ~250k edges with a `*..15` hop cap, pure-Cypher `shortestPath` plus
  `reduce()` over candidate paths is within budget.

## Decision

**Algorithm.** Weighted shortest-path is pure Cypher: enumerate
`shortestPath` candidates, compute `total_weight` per candidate as
`reduce(t=0, w IN relationships(p) | t + w.weight)` (null when any edge
weight is null), order by `total_weight NULLS LAST, hops ASC`. No
APOC, no GDS, no plugin dependency.

**Edge schema.** `:CONNECTS_TO { weight: float|null, ... }`. Null means
"no observed ISIS cost for this edge" — the hop is still valid, it just
has no weight. Adding `weight_source`, `weight_observed_at`, `weight_vendor`
is deferred to PR 2 when the ClickHouse ingest actually has values to
attribute.

**Edge-match key (PR 2).** The join between ClickHouse `isis_cost` and
the Neo4j edge is canonical unordered `(device_name, interface)` on
**both** sides: `{(Device_A_Name, Device_A_Interface), (Device_B_Name,
Device_B_Interface)}`. Trunk columns are unusable — `app_lldp` has only
the A-side trunk, and the format differs between sources (free-text
vs. numeric IDs). Interface is present and consistent on both sides.

**Fallback.** If **any** edge on every candidate path has null weight,
the resolver falls back to unweighted `shortestPath` (hop count). The
UI surfaces this explicitly as an informational banner — not a warning.
Partial coverage is the expected steady state until all vendors are
onboarded to the upstream ISIS pipeline.

**Device-to-device predicate.** For same-level endpoints the monotonic
predicate degenerates to "no movement allowed" and fails. We replace it
with a corridor: `level ∈ [min(src,tgt).level − 1, max(src,tgt).level + 1]`.
For cross-level endpoints the corridor collapses to the same behaviour
as the monotonic predicate over the relevant range.

## Consequences

- PR 1 ships with `weight=null` on every edge (no ingestion yet) and
  exercises only the fallback path in production. Tests seed weights
  directly in Neo4j to cover the weighted branch.
- PR 2 introduces a ClickHouse client and writes `weight` on the edge
  during the existing nightly ingest, plus an admin on-demand trigger.
  No algorithm change in PR 2.
- Cross-vendor weight-scale mismatch (narrow vs. wide metrics) is a
  known limitation — documented, not coded. A v2.1 ticket will add a
  diagnostic query that flags vendor mix on chosen paths.
- Pure Cypher is within budget today (~250k edges, `*..15` cap). If a
  larger graph pushes query time past SLO, the replacement is APOC
  Extended (`apoc.algo.dijkstra`) — a plugin install, not an algorithm
  rewrite.
```

**Step 2: Commit**

```bash
git add docs/decisions/0004-isis-weight-policy.md
git commit -m "docs: flesh out ADR 0004 ISIS weight policy (#60)"
```

---

## Task 14 — Verification before PR

**Files:** none (verification only)

**Step 1: Full web test suite**

```bash
pnpm --filter @tsm/db build
pnpm --filter web test
pnpm --filter web test:int
pnpm --filter web test:e2e
pnpm -r lint
pnpm --filter web exec tsc --noEmit
```
Expected: all green.

**Step 2: Smoke the ingestor + ingest int tests (no regressions)**

```bash
pnpm --filter ingestor test
```
Expected: green. We did not touch the ingestor in PR 1; any failure is a
cross-cutting regression.

**Step 3: Grep for any lingering references to "advisory" path behaviour**

```bash
rg -n "advisory" apps/ docs/
```
Expected: matches only in ADR/plan history, not in production code.

**Step 4: Confirm acceptance criteria checklist — see below**

**Step 5: REQUIRED SUB-SKILL — Use superpowers:verification-before-completion**

Before opening the PR, produce fresh evidence for each criterion:

| AC | Evidence command |
|----|------------------|
| 2  | `pnpm --filter web test:int -t "min-weight path"` |
| 2  | `pnpm --filter web test:int -t "min-hop when any edge"` |
| 3  | `pnpm --filter web test apps/web/test/path-view.test.tsx -t "unweighted"` |
| 4  | `pnpm --filter web test:int -t "device-to-device"` |
| 5  | `pnpm --filter web test:e2e -g "renders A->B"` |
| 6  | `pnpm --filter web test apps/web/test/path-view.test.tsx -t "weight badges"` |
| 7  | same as AC 2 |
| 8  | same as AC 4 |
| 9  | same as AC 5 |
| 10 | `ls docs/decisions/0004-isis-weight-policy.md` |

No claim of completion without the command output in hand. Per
`CLAUDE.md`: banned phrases without evidence — "should work",
"probably fixed", "looks good".

---

## Task 15 — Open PR

**Files:** none (git/gh only)

```bash
git push -u origin feat/issue-60-weighted-graph
gh pr create --title "feat: weighted graph + device-to-device path-trace (#60)" --body "$(cat <<'EOF'
## Summary
- Pure-Cypher weighted shortest-path in apps/web/lib/path.ts with hop-count fallback when any edge weight is null; no APOC/GDS plugin.
- Device-to-device mode via new `to` param with same-level corridor predicate (`level ∈ [min−1, max+1]`).
- PathView banner + per-hop ISIS-cost badges; `/topology?from=...&to=...` now renders A→B instead of A→core.
- ADR 0004 documents weight policy, edge-match key, APOC/GDS rejection.

## Closes
Part of #60 (PR 1 of 2). PR 2 (separate issue to be opened) will add the ClickHouse ingest and admin freshness surface.

## Parent PRD
#57

## Acceptance Criteria Verification (from #60)
- [x] #2 weighted Dijkstra when all edges weighted; hop fallback otherwise — apps/web/test/path.int.test.ts "min-weight path", "min-hop when any edge"
- [x] #3 unweighted banner — apps/web/test/path-view.test.tsx "unweighted"
- [x] #4 device-to-device (same-level corridor) — apps/web/test/path.int.test.ts "device-to-device"
- [x] #5 /topology?to= renders A→B — apps/web/test/topology.int.test.ts + apps/web/e2e/topology.spec.ts
- [x] #6 per-hop weight column when weighted — apps/web/test/path-view.test.tsx "weight badges"
- [x] #7 weighted min-weight int test — apps/web/test/path.int.test.ts
- [x] #8 device-to-device int test — apps/web/test/path.int.test.ts
- [x] #9 E2E two-endpoint render — apps/web/e2e/topology.spec.ts
- [x] #10 ADR landed — docs/decisions/0004-isis-weight-policy.md
- [ ] #1 (PR 2) ISIS cost ingestion — out of scope for this PR

## Test Plan
- [x] pnpm --filter web test
- [x] pnpm --filter web test:int
- [x] pnpm --filter web test:e2e
- [x] pnpm --filter ingestor test (no regressions)
- [x] pnpm -r lint && tsc --noEmit
EOF
)"
```

---

## Follow-up (not in this PR)

- Open new issue "#60.1 — ISIS weight ingestion from ClickHouse" covering the PR 2 scope: ClickHouse client, nightly + on-demand ingest stage, admin freshness badge, testcontainer ClickHouse, `weight_source`/`weight_observed_at` edge properties.
- Update issue #60's "Blocked by" / "Blocks" to reflect the split once the follow-up issue exists.
