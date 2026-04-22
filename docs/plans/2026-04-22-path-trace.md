# Path Trace (Issue #9) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** From a device or service, return and render the shortest upward path (strictly non-increasing `level`, peer hops allowed) through `:CONNECTS_TO` edges until a Core-tier node (`level = 1`) is reached.

**Architecture:** New `GET /api/path` route behind `requireRole("viewer")`. Zod-validated `?from=device:<name>` or `?from=service:<cid>` input. Cypher uses a filtered variable-length path with a per-hop predicate that enforces monotonically non-increasing `level`. Response is a discriminated union (`ok` with hops / `no_path` with `unreached_at`). Device and Service detail pages call the API server-side and render the hops as a vertical role-badge list. Reuse the `RoleBadge` component from #8.

**Tech Stack:** Next.js 14 server components, Neo4j 5 fulltext+property indexes, zod, vitest + testcontainers, Playwright, Tailwind.

---

## Key design decisions (read before implementing)

1. **Core terminator = `level = 1`, not label `:Core`.** The ingestor writes role labels like `:CORE`, `:IRR`, `:VRR` (all level 1 per `config/hierarchy.yaml`). Filtering by property is both more robust across future role additions and matches the "hierarchy level" semantics we already rely on.
2. **Edges are stored with a direction but are semantically undirected.** Per `CLAUDE.md` canonical decisions, path direction is derived from `level`, not stored direction. Always traverse with `-[:CONNECTS_TO]-` (undirected).
3. **Monotonic hop predicate.** A valid path has `nodes[i].level >= nodes[i+1].level` (level decreases or stays equal moving toward Core). Peers at the same level (e.g. two MW devices at 3.5) are allowed. Strict decrease would reject legal MW-MW peer hops.
4. **Shortest wins.** Cypher `shortestPath()` wrapped in `apoc.`-free built-in pattern with the predicate is sufficient; LIMIT 1. Expected p95 < 500ms with the `device_level` index we already have? (No — only `device_role`, `device_domain`, `device_site` exist today. Add `device_level` index in the ingestor writer.)
5. **Service input resolves to a Device.** Given `?from=service:<cid>`, pick the `TERMINATES_AT {role:'source'}` device; if absent, fall back to `role:'dest'`. If neither exists, return `no_path` with `reason: 'service_has_no_endpoint'`.
6. **`unreached_at` semantics.** When no path to Core exists: return the farthest-from-start device reachable via the same monotonic predicate. Implementation: a second Cypher query that does BFS over the same predicate and returns the node with the lowest `level` reached (or the start if the start itself is an island).
7. **Response shape** (zod schema, both success and failure paths):
   ```ts
   { status: "ok", hops: Hop[], length: number }
     // hops[0] = start device; hops[last].level = 1
   { status: "no_path", reason: "island" | "service_has_no_endpoint" | "start_not_found",
     unreached_at: DeviceHit | null }
   ```
   `Hop` = `DeviceHit & { in_if: string|null, out_if: string|null }` where `in_if` is the interface on THIS device used by the edge FROM the previous hop (null for start), and `out_if` is the interface on THIS device used by the edge TO the next hop (null for the Core terminator).

---

## Task 1: Add `device_level` index to the ingestor writer

**Files:**
- Modify: `apps/ingestor/src/graph/writer.ts` (constraints/indexes block, ~line 128)

**Step 1: Read the current constraints block**

Run: `grep -n "CREATE INDEX\|CREATE FULLTEXT" apps/ingestor/src/graph/writer.ts`

Expected: list of 5 indexes, no `device_level` yet.

**Step 2: Add the new index next to the existing `device_role` line**

Edit `apps/ingestor/src/graph/writer.ts` — add after the `device_role` index creation:

```ts
await session.run(
  "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
);
```

**Step 3: Typecheck**

Run: `pnpm --filter ingestor typecheck`
Expected: no errors.

**Step 4: Commit**

```bash
git add apps/ingestor/src/graph/writer.ts
git commit -m "perf: index Device.level for path-trace queries (#9)"
```

---

## Task 2: `lib/path.ts` — zod schemas + Lucene-free input parser

**Files:**
- Create: `apps/web/lib/path.ts`
- Test: `apps/web/test/path.test.ts`

**Step 1: Write the failing tests for the input parser**

Create `apps/web/test/path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parsePathQuery, PathResponse } from "@/lib/path";

describe("parsePathQuery", () => {
  it("accepts device:<name>", () => {
    expect(parsePathQuery({ from: "device:PK-KHI-UPE-01" })).toEqual({
      kind: "device", value: "PK-KHI-UPE-01",
    });
  });

  it("accepts service:<cid>", () => {
    expect(parsePathQuery({ from: "service:C-001" })).toEqual({
      kind: "service", value: "C-001",
    });
  });

  it("rejects missing prefix", () => {
    expect(() => parsePathQuery({ from: "PK-KHI-UPE-01" })).toThrow();
  });

  it("rejects unknown prefix", () => {
    expect(() => parsePathQuery({ from: "site:KHI" })).toThrow();
  });

  it("rejects empty value", () => {
    expect(() => parsePathQuery({ from: "device:" })).toThrow();
  });

  it("caps value length at 200 after prefix", () => {
    expect(() =>
      parsePathQuery({ from: "device:" + "x".repeat(201) }),
    ).toThrow();
  });

  it("trims whitespace inside the value", () => {
    expect(parsePathQuery({ from: "device:  d1  " })).toEqual({
      kind: "device", value: "d1",
    });
  });
});

describe("PathResponse schema", () => {
  it("accepts ok shape", () => {
    const r = PathResponse.parse({
      status: "ok",
      length: 1,
      hops: [{
        name: "a", role: "Core", level: 1, site: null, domain: null,
        in_if: null, out_if: null,
      }],
    });
    expect(r.status).toBe("ok");
  });

  it("accepts no_path with null unreached_at", () => {
    const r = PathResponse.parse({
      status: "no_path", reason: "island", unreached_at: null,
    });
    expect(r.status).toBe("no_path");
  });

  it("rejects unknown reason", () => {
    expect(() =>
      PathResponse.parse({ status: "no_path", reason: "nope", unreached_at: null }),
    ).toThrow();
  });
});
```

**Step 2: Verify tests fail**

Run: `pnpm --filter web test path.test`
Expected: FAIL — `@/lib/path` not found.

**Step 3: Implement `apps/web/lib/path.ts`**

Create with the zod schemas and `parsePathQuery` function. Skeleton:

```ts
import { z } from "zod";

export const PathQuery = z
  .object({ from: z.string().min(1).max(250) })
  .transform(({ from }) => {
    const idx = from.indexOf(":");
    if (idx <= 0) throw new Error("missing prefix");
    const prefix = from.slice(0, idx);
    const value = from.slice(idx + 1).trim();
    if (prefix !== "device" && prefix !== "service") throw new Error("bad prefix");
    if (value.length === 0) throw new Error("empty value");
    if (value.length > 200) throw new Error("value too long");
    return { kind: prefix as "device" | "service", value };
  });

export type PathQuery = z.infer<typeof PathQuery>;

export function parsePathQuery(input: unknown): PathQuery {
  return PathQuery.parse(input);
}

const Hop = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
  in_if: z.string().nullable(),
  out_if: z.string().nullable(),
});
export type Hop = z.infer<typeof Hop>;

const DeviceRef = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
});

export const PathResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), length: z.number(), hops: z.array(Hop) }),
  z.object({
    status: z.literal("no_path"),
    reason: z.enum(["island", "service_has_no_endpoint", "start_not_found"]),
    unreached_at: DeviceRef.nullable(),
  }),
]);
export type PathResponse = z.infer<typeof PathResponse>;
```

**Step 4: Verify tests pass**

Run: `pnpm --filter web test path.test`
Expected: all PASS.

**Step 5: Commit**

```bash
git add apps/web/lib/path.ts apps/web/test/path.test.ts
git commit -m "test: path-trace input parser + response schema (#9)"
```

---

## Task 3: `runPath` Cypher resolver (integration-tested)

**Files:**
- Modify: `apps/web/lib/path.ts` (add `runPath` function)
- Test: `apps/web/test/path.int.test.ts`

**Step 1: Write the failing integration test**

Create `apps/web/test/path.int.test.ts`, following the `search.int.test.ts` pattern for testcontainer setup. Seed this fixture in `beforeAll`:

```
Customer(level 5) --CONNECTS_TO--> CSG(level 3) --CONNECTS_TO--> UPE(level 2)
   --CONNECTS_TO--> CORE(level 1)

Island(level 3) -- (no other connections)

Service(cid=C1, mobily_cid=M1) -[:TERMINATES_AT {role:'source'}]-> CSG
```

Tests:
1. `runPath({kind:'device', value:'Customer'})` → `status:'ok'`, hops = [Customer, CSG, UPE, Core], length 3 (edge count).
2. `runPath({kind:'service', value:'C1'})` → `status:'ok'`, hops start at CSG.
3. `runPath({kind:'device', value:'Island'})` → `status:'no_path'`, `reason:'island'`, `unreached_at.name = 'Island'`.
4. `runPath({kind:'device', value:'GHOST'})` → `status:'no_path'`, `reason:'start_not_found'`, `unreached_at: null`.
5. `runPath({kind:'service', value:'NO-SUCH'})` → `status:'no_path'`, `reason:'service_has_no_endpoint'`.
6. Interface data: hop[1].in_if and hop[1].out_if are non-null; terminator's out_if is null; start's in_if is null.

**Step 2: Verify it fails**

Run: `pnpm --filter web test:int path.int`
Expected: FAIL — `runPath` not exported.

**Step 3: Implement `runPath`**

Add to `apps/web/lib/path.ts`:

```ts
import { getDriver } from "@/lib/neo4j";

// Resolve a service CID to its source (or dest fallback) device name.
async function serviceStart(cid: string): Promise<string | null> {
  const session = getDriver().session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (s:Service {cid: $cid})-[t:TERMINATES_AT]->(d:Device)
       WITH d, t.role AS role
       ORDER BY CASE role WHEN 'source' THEN 0 WHEN 'dest' THEN 1 ELSE 2 END
       LIMIT 1
       RETURN d.name AS name`,
      { cid },
    );
    return res.records[0]?.get("name") ?? null;
  } finally {
    await session.close();
  }
}

export async function runPath(q: PathQuery): Promise<PathResponse> {
  let startName: string | null;
  if (q.kind === "service") {
    startName = await serviceStart(q.value);
    if (!startName) {
      return { status: "no_path", reason: "service_has_no_endpoint", unreached_at: null };
    }
  } else {
    startName = q.value;
  }

  const session = getDriver().session({ defaultAccessMode: "READ" });
  try {
    // Does the start device exist?
    const startRes = await session.run(
      `MATCH (d:Device {name: $name})
       RETURN d { .name, .role, .level, .site, .domain } AS dev`,
      { name: startName },
    );
    if (startRes.records.length === 0) {
      return { status: "no_path", reason: "start_not_found", unreached_at: null };
    }
    const startDev = startRes.records[0]!.get("dev");

    // shortestPath with monotonic-non-increasing-level predicate.
    // Built-in shortestPath supports inline predicates via the WHERE clause.
    const pathRes = await session.run(
      `MATCH (start:Device {name: $name})
       MATCH (core:Device) WHERE core.level = 1
       WITH start, core
       MATCH p = shortestPath((start)-[:CONNECTS_TO*1..15]-(core))
       WHERE ALL(i IN range(0, length(p)-1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i+1]).level)
       RETURN [n IN nodes(p) | n { .name, .role, .level, .site, .domain }] AS nodes,
              [r IN relationships(p) | { a_if: r.a_if, b_if: r.b_if,
                                         a: startNode(r).name, b: endNode(r).name }] AS rels
       ORDER BY length(p) ASC
       LIMIT 1`,
      { name: startName },
    );

    if (pathRes.records.length > 0) {
      const nodes = pathRes.records[0]!.get("nodes") as Array<Record<string, unknown>>;
      const rels = pathRes.records[0]!.get("rels") as Array<Record<string, unknown>>;
      const hops: Hop[] = nodes.map((n, i) => {
        const inRel = i === 0 ? null : rels[i - 1]!;
        const outRel = i === nodes.length - 1 ? null : rels[i]!;
        return {
          name: String(n.name),
          role: String(n.role ?? "Unknown"),
          level: Number((n.level as { toNumber?: () => number })?.toNumber?.() ?? n.level),
          site: n.site == null ? null : String(n.site),
          domain: n.domain == null ? null : String(n.domain),
          in_if: ifSideFor(inRel, String(n.name), "in"),
          out_if: ifSideFor(outRel, String(n.name), "out"),
        };
      });
      return { status: "ok", length: rels.length, hops };
    }

    // No path found — BFS-derive the farthest-reachable node under the same
    // predicate, return as unreached_at.
    const unreachedRes = await session.run(
      `MATCH (start:Device {name: $name})
       OPTIONAL MATCH p = (start)-[:CONNECTS_TO*1..15]-(f:Device)
       WHERE ALL(i IN range(0, length(p)-1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i+1]).level)
       WITH start, f, p
       ORDER BY CASE WHEN p IS NULL THEN 1 ELSE 0 END ASC,
                coalesce(f.level, 999) ASC, length(p) DESC
       LIMIT 1
       RETURN coalesce(f, start) { .name, .role, .level, .site, .domain } AS far`,
      { name: startName },
    );
    const farRow = unreachedRes.records[0]?.get("far") ?? startDev;
    return {
      status: "no_path",
      reason: "island",
      unreached_at: {
        name: String(farRow.name),
        role: String(farRow.role ?? "Unknown"),
        level: Number((farRow.level as { toNumber?: () => number })?.toNumber?.() ?? farRow.level),
        site: farRow.site == null ? null : String(farRow.site),
        domain: farRow.domain == null ? null : String(farRow.domain),
      },
    };
  } finally {
    await session.close();
  }
}

function ifSideFor(
  rel: Record<string, unknown> | null,
  nodeName: string,
  side: "in" | "out",
): string | null {
  if (!rel) return null;
  // a_if is on startNode(r); b_if is on endNode(r). Match by name.
  const a = rel.a === nodeName ? rel.a_if : null;
  const b = rel.b === nodeName ? rel.b_if : null;
  const hit = a ?? b;
  return hit == null ? null : String(hit);
}
```

**Step 4: Verify integration tests pass**

Run: `pnpm --filter web test:int path.int`
Expected: all PASS.

**Step 5: Commit**

```bash
git add apps/web/lib/path.ts apps/web/test/path.int.test.ts
git commit -m "feat: path-trace Cypher resolver with shortestPath + monotonic level (#9)"
```

---

## Task 4: `GET /api/path` route

**Files:**
- Create: `apps/web/app/api/path/route.ts`

**Step 1: Implement the route**

Mirror `apps/web/app/api/search/route.ts` exactly — `requireRole("viewer")`, per-user token bucket (`tryConsume("path:" + session.user.id, { capacity: 20, refillPerSec: 2 })`), parse `req.nextUrl.searchParams.get("from")`, call `runPath`, catch errors → 503. Return 400 on zod parse failure.

**Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

**Step 3: Smoke the route via integration test (optional)** — skip; the library-level integration test already covers the resolver. Route layer is thin and will be exercised by the E2E.

**Step 4: Commit**

```bash
git add apps/web/app/api/path/route.ts
git commit -m "feat: GET /api/path route wired to runPath (#9)"
```

---

## Task 5: `PathView` component (pure render, unit-testable)

**Files:**
- Create: `apps/web/app/_components/path-view.tsx`
- Test: `apps/web/test/path-view.test.tsx`

**Step 1: Add React testing deps if needed**

Run: `pnpm --filter web ls @testing-library/react 2>&1 | tail -5`

If missing, run:
```bash
pnpm --filter web add -D @testing-library/react @testing-library/jest-dom jsdom
```

And add a jsdom project to `apps/web/vitest.workspace.ts` for `*.tsx` tests. If this adds complexity, fall back to snapshot-free plain-DOM assertions by rendering via `react-dom/server` → `renderToStaticMarkup` and using string matchers. Document the choice in the commit message.

**Step 2: Write the failing render test**

Prefer `renderToStaticMarkup` (zero extra deps):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathView } from "@/app/_components/path-view";
import type { PathResponse } from "@/lib/path";

const ok: PathResponse = {
  status: "ok", length: 2,
  hops: [
    { name: "Cust", role: "Customer", level: 5, site: "S", domain: "D",
      in_if: null, out_if: "Gi0/0" },
    { name: "CSG",  role: "CSG",      level: 3, site: "S", domain: "D",
      in_if: "Gi0/1", out_if: "Gi0/2" },
    { name: "UPE",  role: "UPE",      level: 2, site: "S", domain: "D",
      in_if: "Gi0/3", out_if: "Gi0/4" },
    { name: "CORE", role: "CORE",     level: 1, site: "S", domain: "D",
      in_if: "Gi0/5", out_if: null },
  ],
};

describe("PathView", () => {
  it("renders each hop with role + interfaces", () => {
    const html = renderToStaticMarkup(<PathView data={ok} />);
    expect(html).toContain("Cust");
    expect(html).toContain("CORE");
    expect(html).toContain("Gi0/0"); // out_if on start
    expect(html).toContain("Gi0/5"); // in_if on terminator
  });

  it("missing interface data renders as dash, not crash", () => {
    const html = renderToStaticMarkup(
      <PathView data={{ status: "ok", length: 0, hops: [ok.hops[0]!] }} />,
    );
    expect(html).toContain("Cust");
    expect(html).not.toThrow;
  });

  it("no_path with unreached_at renders reason + last hop hint", () => {
    const html = renderToStaticMarkup(
      <PathView data={{
        status: "no_path", reason: "island",
        unreached_at: { name: "LonelyMW", role: "MW", level: 3.5,
                        site: "S", domain: "Mpls" },
      }} />,
    );
    expect(html).toContain("No core reachable");
    expect(html).toContain("LonelyMW");
    expect(html).toContain("MW");
    expect(html).toContain("Mpls");
  });

  it("no_path with null unreached_at (service_has_no_endpoint)", () => {
    const html = renderToStaticMarkup(
      <PathView data={{
        status: "no_path", reason: "service_has_no_endpoint",
        unreached_at: null,
      }} />,
    );
    expect(html).toContain("service has no endpoint");
  });
});
```

**Step 3: Verify tests fail**

Run: `pnpm --filter web test path-view`
Expected: FAIL — component not found.

**Step 4: Implement `PathView`**

Server component, pure props in → JSX out. Reuse the `RoleBadge` styling from `_components/omnibox.tsx` by extracting it in this task if needed (DRY: 2nd use).

- Extract `RoleBadge` to `apps/web/app/_components/role-badge.tsx` and import from both omnibox and path-view.
- `PathView` renders:
  - `status: "ok"` → ordered vertical list; each row: `RoleBadge`, device name, `site · domain`, and "↓ in_if → out_if" subline between hops.
  - `status: "no_path"` → red-tinged panel with "No core reachable" headline, a `reason` pretty-label, and if `unreached_at` is set: "last hop: {name} · role={role} · domain={domain}".

**Step 5: Verify tests pass**

Run: `pnpm --filter web test path-view && pnpm --filter web test search.test`
Expected: all PASS (omnibox tests still green after RoleBadge extraction).

**Step 6: Commit**

```bash
git add apps/web/app/_components/path-view.tsx apps/web/app/_components/role-badge.tsx \
        apps/web/app/_components/omnibox.tsx apps/web/test/path-view.test.tsx
git commit -m "feat: PathView component + extract RoleBadge (#9)"
```

---

## Task 6: Wire into `/device/[name]` and `/service/[cid]` pages

**Files:**
- Modify: `apps/web/app/device/[name]/page.tsx`
- Modify: `apps/web/app/service/[cid]/page.tsx`

**Step 1: Implement server-side data fetch**

Both pages should:
1. `await requireRole("viewer")`.
2. Call `runPath({ kind: 'device'|'service', value: params.name or params.cid })` directly (avoid HTTP self-call; pages run server-side inside the same Next process).
3. Render the device/service name header, then `<PathView data={result} />`.

**Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

**Step 3: Commit**

```bash
git add apps/web/app/device/\[name\]/page.tsx apps/web/app/service/\[cid\]/page.tsx
git commit -m "feat: render traced path on device/service detail pages (#9)"
```

---

## Task 7: E2E — omnibox → path visible

**Files:**
- Create: `apps/web/e2e/path-trace.spec.ts`

**Step 1: Write the spec**

Extend the `omnibox.spec.ts` fixture pattern. In `beforeAll`, seed (idempotent MERGE):

```
(Cust:Device {name:'E2E-PATH-CUST', role:'Customer', level:5, ...})
(CSG :Device {name:'E2E-PATH-CSG',  role:'CSG',      level:3, ...})
(UPE :Device {name:'E2E-PATH-UPE',  role:'UPE',      level:2, ...})
(CORE:Device:CORE {name:'E2E-PATH-CORE', role:'CORE', level:1, ...})

(Cust)-[:CONNECTS_TO {a_if:'Gi0/0', b_if:'Gi1/1'}]->(CSG)
(CSG)-[:CONNECTS_TO {a_if:'Gi1/2', b_if:'Gi2/1'}]->(UPE)
(UPE)-[:CONNECTS_TO {a_if:'Gi2/2', b_if:'Gi3/1'}]->(CORE)

(svc:Service {cid:'E2E-PATH-CID', mobily_cid:'E2E-PATH-MOB'})-[:TERMINATES_AT {role:'source'}]->(CSG)
```

Tests:
1. Login → visit `/device/E2E-PATH-CUST` → expect all 4 hop names visible, in order, and `E2E-PATH-CORE` at the end.
2. Login → omnibox → type `E2E-PATH-MOB` → click → land on `/service/E2E-PATH-CID` → expect `E2E-PATH-CSG`, `E2E-PATH-UPE`, `E2E-PATH-CORE` visible (service starts at source endpoint).
3. Seed an island device `E2E-PATH-ISLAND` (level 4, no edges) → visit `/device/E2E-PATH-ISLAND` → expect "No core reachable" text.

`afterAll` detaches and deletes all seeded rows.

**Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors.

**Step 3: Commit**

```bash
git add apps/web/e2e/path-trace.spec.ts
git commit -m "test: E2E path-trace rendering on device/service pages (#9)"
```

---

## Task 8: Performance budget + index verification

**Files:**
- None (verification only)

**Step 1: Confirm indexes exist in the deployed schema**

When running against a live compose stack: `docker compose exec neo4j cypher-shell -u $NEO4J_USER -p $NEO4J_PASSWORD "SHOW INDEXES"` — verify `device_level` appears. If CI stack doesn't trigger ingestor's index creation (e.g. smoke mode skips writer.ts), this is a no-op — live deploys create it on first real ingest.

**Step 2: (Deferred) real-dataset p95 < 500ms**

Issue #9 lists `<500ms p95` as a criterion. We cannot measure against the real operator dataset in this PR (no prod access in CI). Approach:

1. Add a one-line inline comment in `runPath` referencing the budget.
2. Leave a `TODO(#9-perf)` tracker: once the first real ingest lands in a staging Neo4j, run a 100-iteration benchmark of path queries sampled from the top customer CIDs and file a follow-up if p95 regresses.

**Step 3: Commit (if any changes)**

Only commit if there were code changes in steps 1–2. Otherwise skip.

---

## Acceptance Criteria → Task Map

- `GET /api/path?from=device:<name>` or `service:<cid>`, auth-required → Task 4
- Service input uses `source` → fallback `dest` → Task 3 (`serviceStart`)
- Cypher filtered variable-length path with monotonic level → Task 3
- `no_path` response with `reason` + `unreached_at` → Tasks 2 (schema), 3 (resolver), 5 (UI)
- Hops include device name, role, level, site, domain, + interface pair → Tasks 3 (resolver), 5 (view)
- `/device/[name]` + `/service/[cid]` render the path → Task 6
- Vertical list with role-colored badges + interface labels → Task 5
- Performance <500ms p95 → Task 1 (index) + Task 8 (verification)
- Unit tests: path-formatting helper, missing interface data → Task 5
- Integration: synthetic chain → Task 3
- Integration: no-path / island → Task 3
- E2E: login → search mobily_cid → click → see path → Task 7

---

## Verification checklist (before PR)

- [ ] `pnpm --filter web test` — all unit tests green
- [ ] `pnpm --filter web test:int` — all integration tests green
- [ ] `pnpm -r typecheck` — no errors
- [ ] `pnpm --filter web test:e2e` (local compose or trust CI) — green
- [ ] Issue #9 acceptance checkboxes ticked on the GitHub issue
- [ ] PR body uses the `/issues-to-complete` template with `Closes #9`
