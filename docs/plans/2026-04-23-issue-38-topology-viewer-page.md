# S20 — Topology Viewer Page `/topology` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development for same-session execution) to implement this plan task-by-task.

**Goal:** Ship a single `/topology` route that renders three reactflow views — full path A→B, N-hop ego graph around a device, and a core-overview — with full URL-state round-trip, reusing existing graph/cluster/path primitives.

**Architecture:** Server component reads validated search params, runs one of three Neo4j resolvers (`runPath` reused + two new ones: `runEgoGraph`, `runCoreOverview`) shaped into a common `{ nodes: Node[], edges: Edge[] }` graph DTO, then hands the DTO to a client-only `GraphCanvas` mounted via `next/dynamic({ ssr: false })`. Cluster collapsing (S17) is applied post-resolve using `shouldCluster` on UPE groups per site. Page is pure server-side data; no client fetches.

**Tech Stack:** Next.js 14 (App Router, server components), reactflow + dagre (already integrated), neo4j-driver, zod for param validation, vitest + testcontainers for integration tests, Playwright for E2E.

---

## Shared Conventions

- Every file path is relative to repo root.
- Commits: Conventional Commits, each referencing `(#38)` per `CLAUDE.md`.
- Never commit real operator data; all fixtures use `E2E-*` or synthetic prefixes.
- Write failing test FIRST, run it, confirm failure, then implement. Commit test + impl sequence honored (`test:` → `feat:`).
- Shared module edit protocol applies when touching `apps/web/components/graph/*`, `apps/web/lib/path.ts`, `apps/web/lib/cluster.ts`. Use Serena (`find_referencing_symbols`, `get_symbols_overview`) before editing.

---

## Task 1: Graph DTO + URL-param schema

**Why first:** Every downstream mode produces the same shape. Pinning the contract now prevents rework in tasks 2–4.

**Files:**
- Create: `apps/web/lib/topology.ts`
- Create: `apps/web/test/topology.test.ts`

### Step 1: Write failing unit tests for `parseTopologyQuery` + `toGraphDTO`

Write `apps/web/test/topology.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseTopologyQuery,
  hopsToGraphDTO,
  applyUpeClustering,
  type TopologyQuery,
} from "@/lib/topology";
import type { Hop } from "@/lib/path";

describe("parseTopologyQuery", () => {
  it("path mode requires both from and to", () => {
    const q = parseTopologyQuery({ from: "device:A", to: "device:B" });
    expect(q).toEqual({
      mode: "path",
      from: { kind: "device", value: "A" },
      to: { kind: "device", value: "B" },
      cluster: null,
      include_transport: false,
    });
  });

  it("ego mode reads around + hops", () => {
    const q = parseTopologyQuery({ around: "UPE-01", hops: "2" });
    expect(q).toEqual({
      mode: "ego",
      around: "UPE-01",
      hops: 2,
      cluster: null,
      include_transport: false,
    });
  });

  it("core mode is the default when no recognized params provided", () => {
    const q = parseTopologyQuery({});
    expect(q).toEqual({
      mode: "core",
      cluster: null,
      include_transport: false,
    });
  });

  it("rejects hops above the cap", () => {
    expect(() => parseTopologyQuery({ around: "X", hops: "99" })).toThrow();
  });

  it("rejects from without to in path mode", () => {
    expect(() => parseTopologyQuery({ from: "device:A" })).toThrow();
  });

  it("round-trips cluster=1 and include_transport=1", () => {
    const q = parseTopologyQuery({ around: "X", cluster: "1", include_transport: "1" });
    expect(q.cluster).toBe(true);
    expect(q.include_transport).toBe(true);
  });
});

describe("hopsToGraphDTO", () => {
  const hops: Hop[] = [
    { name: "CUST", role: "Customer", level: 5, site: "S1", domain: null, in_if: null, out_if: "ge-0/0" },
    { name: "CSG",  role: "CSG",      level: 3, site: "S1", domain: null, in_if: "ge-0/1", out_if: "xe-1" },
    { name: "CORE", role: "CORE",     level: 1, site: "S2", domain: null, in_if: "xe-0", out_if: null },
  ];

  it("emits one device node per hop and one edge per adjacent pair", () => {
    const { nodes, edges } = hopsToGraphDTO(hops);
    expect(nodes.map(n => n.id)).toEqual(["CUST", "CSG", "CORE"]);
    expect(nodes.every(n => n.type === "device")).toBe(true);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ source: "CUST", target: "CSG" });
  });

  it("deduplicates when the same name appears twice (loops)", () => {
    const loopy: Hop[] = [...hops, hops[0]!];
    const { nodes } = hopsToGraphDTO(loopy);
    expect(new Set(nodes.map(n => n.id)).size).toBe(nodes.length);
  });
});

describe("applyUpeClustering", () => {
  const mk = (name: string, site: string, role = "UPE", level = 2) => ({
    id: name, type: "device" as const, data: { name, role, level, site }, position: { x: 0, y: 0 },
  });

  it("collapses >3 UPEs at the same site into a cluster node", () => {
    const nodes = [
      mk("U1", "A"), mk("U2", "A"), mk("U3", "A"), mk("U4", "A"),
      mk("C1", "A", "CSG", 3),
    ];
    const edges = [
      { id: "e1", source: "C1", target: "U1" },
      { id: "e2", source: "C1", target: "U2" },
    ];
    const { nodes: out, edges: outEdges } = applyUpeClustering(nodes, edges, null);
    expect(out.find(n => n.type === "cluster")).toBeTruthy();
    expect(out.filter(n => n.id.startsWith("U")).length).toBe(0);
    // edges from CSG to UPEs should re-route to the cluster node
    expect(outEdges.every(e => e.target !== "U1")).toBe(true);
  });

  it("leaves UPEs alone at or below threshold", () => {
    const nodes = [mk("U1", "A"), mk("U2", "A"), mk("U3", "A")];
    const { nodes: out } = applyUpeClustering(nodes, [], null);
    expect(out.filter(n => n.type === "cluster").length).toBe(0);
  });

  it("honors cluster=false override even above threshold", () => {
    const nodes = [mk("U1", "A"), mk("U2", "A"), mk("U3", "A"), mk("U4", "A")];
    const { nodes: out } = applyUpeClustering(nodes, [], false);
    expect(out.filter(n => n.type === "cluster").length).toBe(0);
  });
});
```

### Step 2: Run — expect import failures

Run: `pnpm --filter web test topology.test.ts`
Expected: FAIL — module not found.

### Step 3: Implement `apps/web/lib/topology.ts`

- Export `TopologyQuery` discriminated union `{ mode: "path" | "ego" | "core", ... }` with `cluster: boolean | null` and `include_transport: boolean`.
- Use `z.discriminatedUnion` (mode inferred from presence of `from`+`to` vs `around` vs neither).
- Reuse `parseClusterParam` from `lib/cluster.ts`.
- Reuse hop → graph shape from `Hop` in `lib/path.ts`.
- `applyUpeClustering(nodes, edges, override)`: group by `data.site` where `role === "UPE"`, apply `shouldCluster(count, override)`, replace group with one `{ type: "cluster", data: ClusterNodeData }` node; rewrite any edge endpoint that targeted a now-clustered UPE to target the cluster's id (`cluster:<site>`).
- Hops cap: reuse `MAX_PATH_HOPS = 15` constant — export a new `MAX_EGO_HOPS = 4` (server-interpolated after zod validation, NEVER parameterized in Cypher — see the path.ts/downstream.ts pitfall in `CLAUDE.md`).

### Step 4: Rerun tests — expect green

Run: `pnpm --filter web test topology.test.ts`
Expected: PASS.

### Step 5: Commit

```bash
git add apps/web/lib/topology.ts apps/web/test/topology.test.ts
git commit -m "$(cat <<'EOF'
test: topology query parser + graph DTO + UPE clustering (#38)

Shared primitives for /topology route: zod-validated URL params
(path/ego/core modes), hops → {nodes, edges} adapter, and post-
resolve UPE site-cluster collapse.
EOF
)"
```

---

## Task 2: `runEgoGraph` resolver (N-hop neighborhood)

**Files:**
- Modify: `apps/web/lib/topology.ts` (add server-only resolver)
- Create: `apps/web/test/topology.int.test.ts`

### Step 1: Write failing integration test

Mirror the shape of `apps/web/test/cluster.int.test.ts`. Seed a fixture: CORE — UPE — CSG — RAN — Customer chain plus an islanded device. Assert:

- `runEgoGraph({ name: "UPE", hops: 1 })` returns 3 nodes (UPE, CORE, CSG) and 2 edges.
- `runEgoGraph({ name: "UPE", hops: 2 })` returns 5 nodes including RAN + CUST.
- `runEgoGraph({ name: "ISLAND", hops: 3 })` returns just the island (0 edges).
- `runEgoGraph({ name: "DOES-NOT-EXIST", hops: 1 })` returns `{ start_not_found: true }`.

Run: `pnpm --filter web test:int topology.int.test.ts`
Expected: FAIL (function undefined).

### Step 2: Implement `runEgoGraph`

```ts
export type EgoResult =
  | { status: "ok"; start: DeviceRef; nodes: DeviceRef[]; edges: GraphEdgeRef[] }
  | { status: "start_not_found" };

export async function runEgoGraph(args: { name: string; hops: number }): Promise<EgoResult>;
```

Cypher:

```cypher
MATCH (start:Device {name: $name})
OPTIONAL MATCH p = (start)-[:CONNECTS_TO*0..${hops}]-(reached:Device)
WITH start, collect(DISTINCT reached) AS ns
UNWIND ns AS n
OPTIONAL MATCH (n)-[r:CONNECTS_TO]-(m:Device) WHERE m IN ns AND id(n) < id(m)
RETURN start { .name, .role, .level, .site, .domain } AS start,
       collect(DISTINCT n { .name, .role, .level, .site, .domain }) AS nodes,
       collect(DISTINCT { a: startNode(r).name, b: endNode(r).name }) AS edges
```

Interpolate `$hops` only after `z.number().int().min(1).max(MAX_EGO_HOPS)` (per `CLAUDE.md` pitfall).

### Step 3: Run integration tests

Run: `pnpm --filter web test:int topology.int.test.ts`
Expected: PASS, 4 assertions green.

### Step 4: Commit

```bash
git add apps/web/lib/topology.ts apps/web/test/topology.int.test.ts
git commit -m "test: runEgoGraph N-hop neighborhood resolver (#38)"
# then
git commit --amend --no-edit  # NO — never amend. Skip this line; test + impl land together since they live in the same commit under TDD flow when the implementation is minimal.
```

(Commit once — test file + lib change land together; the RED state is demonstrated by the run log captured in step 1.)

---

## Task 3: `runCoreOverview` resolver

**Files:**
- Modify: `apps/web/lib/topology.ts`
- Modify: `apps/web/test/topology.int.test.ts`

### Step 1: Extend int test

Seed two cores and a UPE connected to each. Assert `runCoreOverview()` returns both cores + their 1-hop neighbors, deduplicated.

### Step 2: Implement

Cypher (filter by `level=1` — NEVER by `:Core` label per `CLAUDE.md` pitfall):

```cypher
MATCH (c:Device) WHERE c.level = 1
OPTIONAL MATCH (c)-[r:CONNECTS_TO]-(n:Device)
WITH collect(DISTINCT c) + collect(DISTINCT n) AS all_nodes,
     collect(DISTINCT r) AS all_rels
UNWIND all_nodes AS d
RETURN collect(DISTINCT d { .name, .role, .level, .site, .domain }) AS nodes,
       [r IN all_rels | { a: startNode(r).name, b: endNode(r).name }] AS edges
```

### Step 3: Run + commit

```bash
pnpm --filter web test:int topology.int.test.ts
git add apps/web/lib/topology.ts apps/web/test/topology.int.test.ts
git commit -m "feat: runCoreOverview resolver for /topology core mode (#38)"
```

---

## Task 4: `/topology` page — server component

**Files:**
- Create: `apps/web/app/topology/page.tsx`
- Create: `apps/web/app/topology/topology-canvas.tsx` (client-only wrapper)

### Step 1: Sketch the page (server)

```tsx
// apps/web/app/topology/page.tsx
import nextDynamic from "next/dynamic";
import { requireRole } from "@/lib/rbac";
import { parseTopologyQuery, hopsToGraphDTO, applyUpeClustering, runEgoGraph, runCoreOverview } from "@/lib/topology";
import { runPath } from "@/lib/path";

export const dynamic = "force-dynamic";

const TopologyCanvas = nextDynamic(
  () => import("./topology-canvas").then((m) => m.TopologyCanvas),
  { ssr: false, loading: () => <CanvasSkeleton /> },
);

export default async function TopologyPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  await requireRole("viewer");

  let q;
  try { q = parseTopologyQuery(searchParams); }
  catch (e) { return <QueryErrorPanel error={e} />; }

  let graph;
  if (q.mode === "path") {
    const path = await runPath({ kind: q.from.kind, value: q.from.value });
    // Constrain endpoint to `to` if needed (future): for MVP, surface error if path's terminal core != q.to when to is a device.
    graph = path.status === "ok" ? hopsToGraphDTO(path.hops) : { nodes: [], edges: [], note: path.reason };
  } else if (q.mode === "ego") {
    const ego = await runEgoGraph({ name: q.around, hops: q.hops ?? 1 });
    graph = egoToGraphDTO(ego, { include_transport: q.include_transport });
  } else {
    const core = await runCoreOverview();
    graph = coreToGraphDTO(core);
  }

  const withCluster = applyUpeClustering(graph.nodes, graph.edges, q.cluster);
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <TopologyHeader q={q} />
      <TopologyCanvas nodes={withCluster.nodes} edges={withCluster.edges} />
    </main>
  );
}
```

- Client wrapper `topology-canvas.tsx` imports `GraphCanvas` and forwards props. Exists so the server page doesn't pull in reactflow (same pattern as `graph-preview/preview-canvas.tsx`).

### Step 2: Add a thin view-level unit test

`apps/web/test/topology-page.test.tsx` — use `renderToStaticMarkup` on the server component with mocked resolvers (or the helpers alone). Verify:
- Unknown mode → error panel markup present
- Path `no_path` → renders "No path" note, no graph

(Keep unit here minimal. Real coverage lands in E2E — step 3.)

### Step 3: Run unit + typecheck

```bash
pnpm -r typecheck
pnpm --filter web test topology-page.test.tsx
```

### Step 4: Commit

```bash
git add apps/web/app/topology apps/web/test/topology-page.test.tsx
git commit -m "feat(web): /topology route with path/ego/core modes (#38)"
```

---

## Task 5: Playwright E2E — customer→core trace renders with icons + level badges

**Files:**
- Create: `apps/web/e2e/topology.spec.ts`

### Step 1: Seed a chain (`E2E-TOPO-CUST → CSG → UPE → CORE`) plus an extra site with 4 UPEs to exercise clustering.

Model after `apps/web/e2e/path-trace.spec.ts` (Postgres user seed + Neo4j device seed helpers). Test cases:

1. **Path mode:** navigate to `/topology?from=device:E2E-TOPO-CUST&to=device:E2E-TOPO-CORE`. Assert 4 `[data-testid="graph-device-node"]` rendered and an icon SVG appears inside the CORE node.
2. **Ego mode:** `/topology?around=E2E-TOPO-UPE&hops=1`. Assert 3 nodes rendered.
3. **Cluster mode:** `/topology?mode=core&cluster=1` where the 4-UPE site collapses — assert exactly one `[data-testid="graph-cluster-node"]` for that site.
4. **URL round-trip:** after (3), `await page.reload()` and re-assert — state must survive reload.

### Step 2: Run E2E against the compose stack

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
pnpm --filter web test:e2e topology.spec.ts
```

### Step 3: Commit

```bash
git add apps/web/e2e/topology.spec.ts
git commit -m "test(e2e): /topology path+ego+cluster URL round-trip (#38)"
```

---

## Task 6: Full regression sweep + PR

### Step 1: Run EVERYTHING green before PR

```bash
pnpm -r typecheck
pnpm --filter @tsm/db build
pnpm --filter web test
pnpm --filter web test:int
pnpm --filter web test:e2e
pnpm --filter ingestor test
```

Expected: all green. If red → back to RED-GREEN on the broken suite; do NOT ship.

### Step 2: Update `CLAUDE.md`-adjacent notes only if a new pitfall surfaced (e.g., if reactflow SSR caught you). Otherwise skip — no speculative docs.

### Step 3: Push branch + open PR

```bash
git push -u origin feat/issue-38-topology-viewer-page
gh pr create --title "feat(web): /topology viewer — path + ego + core modes (#38)" --body "<see skill Phase 6 template>"
```

### Step 4: Merge via Phase 6.5 of `/issues-to-complete`.

---

## Non-goals (explicit — do NOT creep)

- No new auth surface — `requireRole("viewer")` reuse only.
- No edit/save controls. Saved-views integration is out of scope (exists independently via `saved-views.ts`; no changes to that module).
- No live WebSocket updates. Pure server render per request.
- No SPOF / bridge detection — deferred per PRD.
- No icon changes — `iconFor` + `ALL_ROLES` stay fixed.
- Do NOT expose Neo4j port in prod compose (existing rule).
- Do NOT parameterize hops in Cypher — validate int, interpolate.

## Acceptance criteria map

| Criterion from #38 | Satisfied by |
|---|---|
| Three modes render without errors on realistic fixtures | Tasks 2, 3, 4 + E2E (1)(2)(3) |
| URL state round-trip | E2E (4) |
| Playwright E2E customer→core with icons + level badges | E2E (1) |
| `?cluster=1` on >3-UPE site | Task 1 unit + E2E (3) |
| No regression in `pnpm --filter web test:int` | Task 6 |
