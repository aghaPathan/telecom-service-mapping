# Impact / Blast-Radius Page (`/impact/[deviceId]`) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Issue:** #40 — S22: Impact / blast-radius page `/impact/[deviceId]`

**Goal:** Ship a dedicated blast-radius page that, given any device, lists every downstream device (CSG/SW/RAN/MW/Customer) in a sortable data-table with hops-from-source, plus a role-count summary and a safe CSV export. Reuses the existing `runDownstream` traversal but extends it with **hops** and **vendor** columns (both required by AC).

**Architecture:**

- New route `/impact/[deviceId]` — `deviceId` = URL-encoded device `name` (canonical key), mirroring `/device/[name]` convention. The issue text says `/devices/[node]` but the codebase standard (set by ADR on #39) is the singular `/device/[name]`; we follow the codebase, and route parameter stays `deviceId` per the issue title.
- New resolver `runImpact` in `apps/web/lib/impact.ts`. It shares the traversal semantics of `runDownstream` (strict level-increasing walk, MW traversal always, MW projection filter) but returns a **flat list** with `hops` (shortest path length from source) and `vendor`. Kept separate from `runDownstream` so the existing downstream page and its CSV endpoint are untouched.
- **Large-result guard:** `HARD_CAP = 10000`. When the total exceeds the cap, the page returns `{ status: "too_large", total, summary }` — the UI renders summary counts plus a CSV download link only; no in-page table. The CSV endpoint itself has no cap (it's a download flow; streaming a 50k-row CSV is fine).
- **Links back:** every row links to `/device/${encodeURIComponent(name)}`.
- **Filter:** `include_transport` bool toggle round-trips via URL; default `false`. `max_depth` reuses downstream's `MAX_DOWNSTREAM_DEPTH=15`.

**Tech stack:** Next.js 14 server components, Neo4j driver (same-process via `@/lib/neo4j`), Zod for query validation, `@/lib/csv` for formula-safe export, Tailwind, Vitest + testcontainers for integration test.

**Acceptance criteria (issue #40):**

- [ ] Page renders for a seeded UPE, lists all its downstream CSG/SW/RAN/Customer
- [ ] `include_transport` toggle round-trips via URL
- [ ] CSV export downloads; filename sanitized; cells pass formula-injection smoke (`=1+1`, `@CMD`, leading tab, etc.)
- [ ] Integration test extends the `downstream.int.test.ts` pattern
- [ ] Large-result guard: if >10k rows, show summary + link to download full CSV

**Out of scope:**
- Adding `hops` to `runDownstream` for the existing downstream page (would change public shape; keep surgical)
- Pagination UI (the 10k cap + CSV-fallback is the agreed scale-out mechanism per issue text)
- Saved-views `kind: "impact"` (not in AC; can land with the /core, /analytics bundle if desired)

---

## Pre-flight

### Task 0: Branch + clean baseline

**Files:** none

**Step 1:** Verify branch.

Run: `git branch --show-current`
Expected: `feat/issue-40-impact-blast-radius`. Unrelated `M CLAUDE.md` is allowed — do NOT stage it.

**Step 2:** Build `@tsm/db` (required before typecheck/tests).

Run: `pnpm --filter @tsm/db build`
Expected: clean build.

**Step 3:** Baseline tests green.

Run: `pnpm --filter web test -- --run`
Expected: all pass. Record count. If red, stop and surface — do not build on broken ground.

---

## Phase A — `runImpact` resolver (TDD, unit-first shape)

**Goal:** a typed, zod-validated resolver. All Cypher goes through testcontainers in Phase B — Phase A covers the pure parsing/shape surface.

### Task 1: Zod schemas for `runImpact` input and response

**Files:**
- Create: `apps/web/lib/impact.ts`
- Create: `apps/web/test/impact.test.ts`

**Step 1: Write failing test** (`apps/web/test/impact.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { parseImpactQuery, HARD_CAP } from "@/lib/impact";

describe("parseImpactQuery", () => {
  it("requires non-empty device", () => {
    expect(() => parseImpactQuery({ device: "" })).toThrow();
  });

  it("coerces include_transport string to bool", () => {
    const q = parseImpactQuery({ device: "X", include_transport: "true" });
    expect(q.include_transport).toBe(true);
    const q2 = parseImpactQuery({ device: "X", include_transport: "false" });
    expect(q2.include_transport).toBe(false);
  });

  it("defaults include_transport to false and max_depth to 10", () => {
    const q = parseImpactQuery({ device: "X" });
    expect(q.include_transport).toBe(false);
    expect(q.max_depth).toBe(10);
  });

  it("caps max_depth at 15", () => {
    expect(() => parseImpactQuery({ device: "X", max_depth: 16 })).toThrow();
  });

  it("exposes HARD_CAP = 10000", () => {
    expect(HARD_CAP).toBe(10000);
  });
});
```

**Step 2: Run, verify it fails** — `pnpm --filter web test -- --run apps/web/test/impact.test.ts`
Expected: module-not-found.

**Step 3: Minimal implementation** (`apps/web/lib/impact.ts`)

```ts
import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { MAX_DOWNSTREAM_DEPTH } from "@/lib/downstream";

export const HARD_CAP = 10_000;

export const ImpactQuery = z.object({
  device: z.string().trim().min(1).max(200),
  max_depth: z.coerce.number().int().min(1).max(MAX_DOWNSTREAM_DEPTH).default(10),
  include_transport: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
});
export type ImpactQuery = z.infer<typeof ImpactQuery>;

export function parseImpactQuery(input: unknown): ImpactQuery {
  return ImpactQuery.parse(input);
}

export const ImpactRow = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  vendor: z.string().nullable(),
  hops: z.number().int(),
});
export type ImpactRow = z.infer<typeof ImpactRow>;

export const RoleSummary = z.object({
  role: z.string(),
  level: z.number(),
  count: z.number().int(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

export const ImpactResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
    rows: z.array(ImpactRow),
  }),
  z.object({
    status: z.literal("too_large"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
  }),
  z.object({ status: z.literal("start_not_found") }),
]);
export type ImpactResponse = z.infer<typeof ImpactResponse>;

// runImpact stub — body lands in Task 2 driven by the integration test.
export async function runImpact(_q: ImpactQuery): Promise<ImpactResponse> {
  throw new Error("runImpact: not implemented");
}
```

**Step 4: Run, verify passing**

Run: `pnpm --filter web test -- --run apps/web/test/impact.test.ts`
Expected: 5 passing.

**Step 5: Commit**

```bash
git add apps/web/lib/impact.ts apps/web/test/impact.test.ts
git commit -m "test: zod schemas for runImpact (#40)"
```

---

## Phase B — `runImpact` against real Neo4j (testcontainers)

### Task 2: Integration test — seed fixture + first assertion (happy path)

**Files:**
- Create: `apps/web/test/impact.int.test.ts`
- Modify: `apps/web/lib/impact.ts` (body)

**Step 1:** Copy the fixture skeleton from `apps/web/test/downstream.int.test.ts` (section labelled "A4-" seed). Add a `vendor` property to every MERGE: `SET ... core.vendor='Cisco'`, `upe1.vendor='Nokia'`, `csg1.vendor='Nokia'`, `ran1.vendor='Ericsson'`, `mw1.vendor=null`, customers `vendor='CPE'`. Use the same container-boot / teardown style. Name the test file `apps/web/test/impact.int.test.ts`. Fixture prefix: `I5-` (isolated from A4/P*/existing prefixes to avoid collisions).

**Step 2: First failing test**

```ts
import { runImpact } from "@/lib/impact";

it("returns flat rows with hops + vendor for a seeded UPE", async () => {
  const res = await runImpact({
    device: "I5-UPE1",
    max_depth: 10,
    include_transport: false,
  });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("unreachable");

  // No MW rows when include_transport is false…
  expect(res.rows.find((r) => r.level === 3.5)).toBeUndefined();
  // …but RANs behind MW are still present (traversal goes THROUGH MW).
  expect(res.rows.find((r) => r.name === "I5-RAN1")).toBeDefined();

  const csg1 = res.rows.find((r) => r.name === "I5-CSG1")!;
  expect(csg1.hops).toBe(1);
  expect(csg1.vendor).toBe("Nokia");

  const ran1 = res.rows.find((r) => r.name === "I5-RAN1")!;
  expect(ran1.hops).toBe(3); // UPE1 -> CSG1 -> MW1 -> RAN1
  expect(ran1.vendor).toBe("Ericsson");

  // summary is grouped by (role, level) — CSGs, RANs, Customers present
  const roles = new Set(res.summary.map((g) => g.role));
  expect(roles.has("CSG")).toBe(true);
  expect(roles.has("RAN")).toBe(true);
  expect(roles.has("Customer")).toBe(true);
  expect(roles.has("MW")).toBe(false);
});
```

**Step 3: Run, verify failing** — `pnpm --filter web test:int -- --run apps/web/test/impact.int.test.ts`
Expected: FAIL with `runImpact: not implemented`.

**Step 4: Implement `runImpact` body** — replace the stub in `apps/web/lib/impact.ts`:

```ts
export async function runImpact(q: ImpactQuery): Promise<ImpactResponse> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const startRes = await session.run(
      `MATCH (d:Device {name:$name})
       RETURN d { .name, .role, .level } AS node`,
      { name: q.device },
    );
    if (startRes.records.length === 0) return { status: "start_not_found" };
    const startNode = startRes.records[0]!.get("node") as Record<string, unknown>;
    const start = {
      name: String(startNode.name),
      role: String(startNode.role ?? "Unknown"),
      level: toNum(startNode.level ?? 0),
    };

    const maxDepth = q.max_depth;
    // Shortest strictly-increasing path per dst, so `hops` is deterministic.
    // The WHERE after DISTINCT keeps MW out of the projection when
    // include_transport is false — matching runDownstream semantics.
    // maxDepth is zod-validated int; safe to interpolate (Neo4j refuses
    // parameters inside variable-length bounds — see runDownstream).
    const rowsRes = await session.run(
      `MATCH p = shortestPath(
         (start:Device {name:$name})-[:CONNECTS_TO*1..${maxDepth}]-(dst:Device)
       )
       WHERE start <> dst
         AND ALL(i IN range(0, length(p)-1)
                 WHERE nodes(p)[i].level < nodes(p)[i+1].level)
       WITH DISTINCT dst, length(p) AS hops
       WHERE $include_transport OR dst.level <> 3.5
       RETURN dst { .name, .role, .level, .site, .vendor } AS node, hops
       ORDER BY hops ASC, dst.level ASC, dst.name ASC`,
      { name: q.device, include_transport: q.include_transport },
    );

    const rows: ImpactRow[] = rowsRes.records.map((rec) => {
      const n = rec.get("node") as Record<string, unknown>;
      return {
        name: String(n.name),
        role: String(n.role ?? "Unknown"),
        level: toNum(n.level ?? 0),
        site: toStrOrNull(n.site),
        vendor: toStrOrNull(n.vendor),
        hops: toNum(rec.get("hops")),
      };
    });

    const byKey = new Map<string, RoleSummary>();
    for (const r of rows) {
      const k = `${r.level} ${r.role}`;
      const existing = byKey.get(k);
      if (existing) existing.count++;
      else byKey.set(k, { role: r.role, level: r.level, count: 1 });
    }
    const summary = [...byKey.values()].sort(
      (a, b) => a.level - b.level || b.count - a.count,
    );
    const total = rows.length;

    if (total > HARD_CAP) {
      return { status: "too_large", start, total, summary };
    }
    return { status: "ok", start, total, summary, rows };
  } finally {
    await session.close();
  }
}

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}
function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
```

**Step 5:** Run, verify passing.

Run: `pnpm --filter web test:int -- --run apps/web/test/impact.int.test.ts`
Expected: 1 passing.

**Step 6: Commit**

```bash
git add apps/web/lib/impact.ts apps/web/test/impact.int.test.ts
git commit -m "feat: runImpact resolver — flat rows with hops + vendor (#40)"
```

### Task 3: Integration test — `include_transport=true` includes MW rows

**Files:**
- Modify: `apps/web/test/impact.int.test.ts`

**Step 1: Add test**

```ts
it("includes MW rows when include_transport=true", async () => {
  const res = await runImpact({
    device: "I5-UPE1",
    max_depth: 10,
    include_transport: true,
  });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("unreachable");
  expect(res.rows.find((r) => r.name === "I5-MW1")).toBeDefined();
  expect(res.rows.find((r) => r.name === "I5-MW1")!.level).toBe(3.5);
});
```

**Step 2:** Run, verify passing.

Run: `pnpm --filter web test:int -- --run apps/web/test/impact.int.test.ts`
Expected: 2 passing.

**Step 3: Commit**

```bash
git add apps/web/test/impact.int.test.ts
git commit -m "test: include_transport toggles MW visibility in runImpact (#40)"
```

### Task 4: Integration test — `start_not_found` + island device (total=0)

**Files:**
- Modify: `apps/web/test/impact.int.test.ts`

**Step 1: Add tests**

```ts
it("returns start_not_found for unknown device", async () => {
  const res = await runImpact({
    device: "I5-MISSING",
    max_depth: 10,
    include_transport: false,
  });
  expect(res.status).toBe("start_not_found");
});

it("returns total=0 ok for isolated node", async () => {
  const res = await runImpact({
    device: "I5-ISLAND",
    max_depth: 10,
    include_transport: false,
  });
  expect(res.status).toBe("ok");
  if (res.status !== "ok") throw new Error("unreachable");
  expect(res.total).toBe(0);
  expect(res.rows).toEqual([]);
  expect(res.summary).toEqual([]);
});
```

The `I5-ISLAND` fixture node (no edges) is copied from `A4-ISLAND`.

**Step 2:** Run, verify passing.

Run: `pnpm --filter web test:int -- --run apps/web/test/impact.int.test.ts`
Expected: 4 passing.

**Step 3: Commit**

```bash
git add apps/web/test/impact.int.test.ts
git commit -m "test: start_not_found + isolated-node cases (#40)"
```

### Task 5: Integration test — large-result guard (`HARD_CAP`) via depth clamp

**Files:**
- Modify: `apps/web/test/impact.int.test.ts`
- Modify: `apps/web/lib/impact.ts` (parameterize HARD_CAP via an optional arg so tests don't need to seed 10k rows)

**Step 1:** Modify `runImpact` to accept an optional override — internal only, NOT exposed on the public route:

```ts
export async function runImpact(
  q: ImpactQuery,
  opts: { hardCap?: number } = {},
): Promise<ImpactResponse> {
  // ...
  const hardCap = opts.hardCap ?? HARD_CAP;
  // ...
  if (total > hardCap) {
    return { status: "too_large", start, total, summary };
  }
  // ...
}
```

**Step 2: Add test using `hardCap: 2`**

```ts
it("returns too_large when total exceeds HARD_CAP", async () => {
  const res = await runImpact(
    { device: "I5-UPE1", max_depth: 10, include_transport: true },
    { hardCap: 2 },
  );
  expect(res.status).toBe("too_large");
  if (res.status !== "too_large") throw new Error("unreachable");
  expect(res.total).toBeGreaterThan(2);
  expect(res.summary.length).toBeGreaterThan(0);
});
```

**Step 3:** Run, verify passing.

Run: `pnpm --filter web test:int -- --run apps/web/test/impact.int.test.ts`
Expected: 5 passing.

**Step 4: Commit**

```bash
git add apps/web/lib/impact.ts apps/web/test/impact.int.test.ts
git commit -m "feat: too_large response when total > HARD_CAP (#40)"
```

---

## Phase C — CSV endpoint

### Task 6: CSV API route

**Files:**
- Create: `apps/web/app/api/impact/csv/route.ts`
- Create: `apps/web/test/impact-csv.int.test.ts`

**Step 1: Integration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Same container-boot helpers as impact.int.test.ts — copy the harness.
// Mount an in-process Next request against the route module.
import { GET } from "@/app/api/impact/csv/route";
import { NextRequest } from "next/server";

// ...after seeding identical I5- fixture...

it("exports CSV with hostname,role,level,site,vendor,hops header", async () => {
  const req = new NextRequest(
    "http://test.local/api/impact/csv?device=I5-UPE1&include_transport=false&max_depth=10",
  );
  const res = await GET(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
  const body = await res.text();
  const [header, ...dataLines] = body.trim().split("\n");
  expect(header).toBe("name,role,level,site,vendor,hops");
  expect(dataLines.some((l) => l.startsWith("I5-CSG1,"))).toBe(true);
});

it("escapes formula-injection attempts in device names", async () => {
  // Seed a hostile name once in a before-hook of this test file:
  //   MERGE (h:Device {name:'=CMD|evil'}) SET h.role='RAN', h.level=4, ...
  //   MERGE (I5-RAN1)-[:CONNECTS_TO]->(h)
  // (adds a single row under I5-UPE1's subtree)
  const req = new NextRequest(
    "http://test.local/api/impact/csv?device=I5-UPE1&include_transport=false&max_depth=10",
  );
  const res = await GET(req);
  const body = await res.text();
  // formula-guarded cell begins with quote + apostrophe
  expect(body).toContain(`"'=CMD|evil"`);
});

it("returns 404 start_not_found for unknown device", async () => {
  const req = new NextRequest(
    "http://test.local/api/impact/csv?device=I5-NOPE",
  );
  const res = await GET(req);
  expect(res.status).toBe(404);
});
```

`requireRole` will fail in the unit-style harness — mock it per the pattern used in `apps/web/app/api/downstream/csv/route.ts` tests (see `apps/web/test/*-csv.int.test.ts` if one exists, otherwise add a `vi.mock("@/lib/rbac", () => ({ requireRole: async () => ({ user: { id: "t", role: "viewer" } }) }))` at the top of the file).

**Step 2:** Run, verify failing (route module missing).

Run: `pnpm --filter web test:int -- --run apps/web/test/impact-csv.int.test.ts`
Expected: FAIL.

**Step 3: Implement route** (`apps/web/app/api/impact/csv/route.ts`)

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseImpactQuery, runImpact } from "@/lib/impact";
import { tryConsume } from "@/lib/rate-limit";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// NOTE: no HARD_CAP here. The page applies the 10k guard; the CSV endpoint
// intentionally streams the full result for download (that's the fallback).
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`impact-csv:${session.user.id}`, {
    capacity: 20,
    refillPerSec: 2,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }

  const input = Object.fromEntries(req.nextUrl.searchParams);
  let parsed;
  try {
    parsed = parseImpactQuery(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  let result;
  try {
    // Pass hardCap: Infinity so the CSV never returns too_large — always
    // returns ok with the full row set.
    result = await runImpact(parsed, { hardCap: Number.POSITIVE_INFINITY });
  } catch (err) {
    log("error", "impact_csv_failed", {
      error: err instanceof Error ? err.message : String(err),
      user: session.user.id,
    });
    return NextResponse.json({ error: "impact_failed" }, { status: 503 });
  }

  if (result.status === "start_not_found") {
    return NextResponse.json({ error: "start_not_found" }, { status: 404 });
  }
  if (result.status === "too_large") {
    // unreachable with hardCap=Infinity but keep the branch for type narrowing
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const header = csvRow(["name", "role", "level", "site", "vendor", "hops"]);
  const body = result.rows
    .map((r) => csvRow([r.name, r.role, r.level, r.site, r.vendor, r.hops]))
    .join("\n");
  const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;

  const filename = `impact-${sanitizeFilename(parsed.device)}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
```

**Step 4:** Run, verify passing.

Run: `pnpm --filter web test:int -- --run apps/web/test/impact-csv.int.test.ts`
Expected: 3 passing.

**Step 5: Commit**

```bash
git add apps/web/app/api/impact/csv/route.ts apps/web/test/impact-csv.int.test.ts
git commit -m "feat: /api/impact/csv endpoint with formula-safe cells (#40)"
```

---

## Phase D — Page UI

### Task 7: Skeleton page with summary + rows table (server component)

**Files:**
- Create: `apps/web/app/impact/[deviceId]/page.tsx`
- Create: `apps/web/test/impact-page.test.tsx`

**Step 1: Failing unit test** — renders summary + a row link, handles `start_not_found`, renders `too_large` state.

Follow the JSX-test pattern from `apps/web/test/path-device-page.test.tsx` / `device-detail-page.test.tsx`: `renderToStaticMarkup` + asserts on substrings. Mock `runImpact` via `vi.mock("@/lib/impact", ...)`.

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const runImpactMock = vi.fn();
vi.mock("@/lib/impact", async () => {
  const actual = await vi.importActual<typeof import("@/lib/impact")>(
    "@/lib/impact",
  );
  return { ...actual, runImpact: (...a: unknown[]) => runImpactMock(...a) };
});

import Page from "@/app/impact/[deviceId]/page";

beforeEach(() => runImpactMock.mockReset());

it("renders rows with links back to /device/[name]", async () => {
  runImpactMock.mockResolvedValueOnce({
    status: "ok",
    start: { name: "U", role: "UPE", level: 2 },
    total: 1,
    summary: [{ role: "CSG", level: 3, count: 1 }],
    rows: [{ name: "C1", role: "CSG", level: 3, site: "S", vendor: "Nokia", hops: 1 }],
  });
  const el = await Page({ params: { deviceId: "U" }, searchParams: {} });
  const html = renderToStaticMarkup(el as React.ReactElement);
  expect(html).toContain(`href="/device/C1"`);
  expect(html).toContain("CSG");
  expect(html).toContain("Nokia");
  expect(html).toContain(">1<"); // hops cell
});

it("shows not-found panel when resolver returns start_not_found", async () => {
  runImpactMock.mockResolvedValueOnce({ status: "start_not_found" });
  const el = await Page({ params: { deviceId: "nope" }, searchParams: {} });
  const html = renderToStaticMarkup(el as React.ReactElement);
  expect(html).toContain("Device not found");
  expect(html.toLowerCase()).toContain("nope");
});

it("shows summary + CSV-only fallback when too_large", async () => {
  runImpactMock.mockResolvedValueOnce({
    status: "too_large",
    start: { name: "U", role: "UPE", level: 2 },
    total: 12345,
    summary: [{ role: "Customer", level: 5, count: 12000 }],
  });
  const el = await Page({ params: { deviceId: "U" }, searchParams: {} });
  const html = renderToStaticMarkup(el as React.ReactElement);
  expect(html).toContain("12,345");
  expect(html).toContain("Download CSV");
  expect(html).not.toContain("<table"); // no in-page table at this scale
});

it("round-trips include_transport=1 via query string", async () => {
  runImpactMock.mockResolvedValueOnce({
    status: "ok",
    start: { name: "U", role: "UPE", level: 2 },
    total: 0,
    summary: [],
    rows: [],
  });
  await Page({ params: { deviceId: "U" }, searchParams: { include_transport: "true" } });
  expect(runImpactMock).toHaveBeenCalledWith(
    expect.objectContaining({ include_transport: true }),
  );
});
```

Verify `apps/web/vitest.workspace.ts` lists `.test.{ts,tsx}` and has `esbuild: { jsx: "automatic" }` for the unit project (per CLAUDE.md pitfall); existing `path-device-page.test.tsx` already proves this — no workspace change needed.

**Step 2:** Run, verify failing — `pnpm --filter web test -- --run apps/web/test/impact-page.test.tsx`
Expected: module-not-found for `@/app/impact/[deviceId]/page`.

**Step 3: Implement page** (`apps/web/app/impact/[deviceId]/page.tsx`)

```tsx
import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { parseImpactQuery, runImpact, type ImpactResponse } from "@/lib/impact";
import { RoleBadge } from "@/app/_components/role-badge";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function summaryLine(
  summary: Extract<ImpactResponse, { status: "ok" | "too_large" }>["summary"],
) {
  const byRole = new Map<string, number>();
  for (const g of summary) byRole.set(g.role, (byRole.get(g.role) ?? 0) + g.count);
  return [...byRole.entries()].map(([r, c]) => `${fmt(c)} ${r}`).join(" · ");
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="impact-error"
    >
      {message}
    </div>
  );
}

export default async function ImpactPage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { [k: string]: string | undefined };
}) {
  await requireRole("viewer");
  const name = decodeURIComponent(params.deviceId);

  let parsed;
  try {
    parsed = parseImpactQuery({ device: name, ...searchParams });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid query.";
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6"><ErrorPanel message={msg} /></div>
      </main>
    );
  }

  let result: ImpactResponse;
  try {
    result = await runImpact(parsed);
  } catch (err) {
    log("error", "impact_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      device: name,
    });
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6">
          <ErrorPanel message="Impact unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref =
    `/api/impact/csv?device=${encodeURIComponent(name)}` +
    `&include_transport=${parsed.include_transport}` +
    `&max_depth=${parsed.max_depth}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header name={name} csvHref={result.status !== "start_not_found" ? csvHref : undefined} />
      <FilterForm
        device={name}
        includeTransport={parsed.include_transport}
        maxDepth={parsed.max_depth}
      />
      {result.status === "start_not_found" ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-100"
            data-testid="impact-not-found"
          >
            Device not found: <span className="font-medium">{name}</span>
          </div>
        </div>
      ) : result.status === "too_large" ? (
        <TooLargeView total={result.total} summary={result.summary} csvHref={csvHref} />
      ) : result.total === 0 ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
            data-testid="impact-empty"
          >
            No devices reachable downstream.
          </div>
        </div>
      ) : (
        <OkView result={result} />
      )}
    </main>
  );
}

function Header({ name, csvHref }: { name: string; csvHref?: string }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <Link
          href={`/device/${encodeURIComponent(name)}`}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          ← Back to device detail
        </Link>
        <h1
          className="mt-1 text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="impact-page-name"
        >
          Impact of {name}
        </h1>
      </div>
      {csvHref && (
        <a
          href={csvHref}
          data-testid="impact-csv-link"
          className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Export CSV
        </a>
      )}
    </div>
  );
}

function FilterForm({
  device,
  includeTransport,
  maxDepth,
}: {
  device: string;
  includeTransport: boolean;
  maxDepth: number;
}) {
  return (
    <form
      method="get"
      action={`/impact/${encodeURIComponent(device)}`}
      className="mt-6 flex flex-wrap items-center gap-4 rounded-md border border-slate-200 bg-white p-3 text-sm ring-1 ring-slate-100"
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="include_transport"
          value="true"
          defaultChecked={includeTransport}
          className="h-4 w-4 rounded border-slate-300"
        />
        <span className="text-slate-700">Include transport (MW)</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-slate-700">Max depth</span>
        <input
          type="number"
          name="max_depth"
          min={1}
          max={15}
          defaultValue={maxDepth}
          className="w-16 rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <button
        type="submit"
        className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
      >
        Apply
      </button>
    </form>
  );
}

function SummarySection({
  summary,
}: {
  summary: Extract<ImpactResponse, { status: "ok" | "too_large" }>["summary"];
}) {
  return (
    <section className="mt-6" data-testid="impact-summary">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {summary.map((g) => (
          <div
            key={`${g.level}-${g.role}`}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 ring-1 ring-slate-100"
          >
            <RoleBadge role={g.role} level={g.level} />
            <span className="text-xs text-slate-600">{fmt(g.count)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function OkView({
  result,
}: {
  result: Extract<ImpactResponse, { status: "ok" }>;
}) {
  return (
    <div>
      <p className="mt-6 text-sm text-slate-700" data-testid="impact-count">
        <span className="font-medium">{fmt(result.total)}</span> downstream devices — {summaryLine(result.summary)}
      </p>
      <SummarySection summary={result.summary} />
      <section className="mt-8" data-testid="impact-table">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Affected devices</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Hostname</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Site</th>
                <th className="py-2 pr-3">Vendor</th>
                <th className="py-2 pr-3 text-right">Hops</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((r) => (
                <tr key={r.name}>
                  <td className="py-1.5 pr-3">
                    <Link
                      href={`/device/${encodeURIComponent(r.name)}`}
                      className="text-sky-700 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">
                    <RoleBadge role={r.role} level={r.level} />
                  </td>
                  <td className="py-1.5 pr-3 text-slate-700">{r.site ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-slate-700">{r.vendor ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{r.hops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TooLargeView({
  total,
  summary,
  csvHref,
}: {
  total: number;
  summary: Extract<ImpactResponse, { status: "too_large" }>["summary"];
  csvHref: string;
}) {
  return (
    <div>
      <div
        className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
        data-testid="impact-too-large"
      >
        <p>
          <span className="font-medium">{fmt(total)}</span> downstream devices — too many to render in-page. Use the CSV export below.
        </p>
        <a
          href={csvHref}
          className="mt-3 inline-flex items-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-50"
        >
          Download CSV
        </a>
      </div>
      <SummarySection summary={summary} />
    </div>
  );
}
```

**Step 4:** Run, verify passing.

Run: `pnpm --filter web test -- --run apps/web/test/impact-page.test.tsx`
Expected: 4 passing.

**Step 5: Commit**

```bash
git add apps/web/app/impact/[deviceId]/page.tsx apps/web/test/impact-page.test.tsx
git commit -m "feat: /impact/[deviceId] page — summary + table + too-large fallback (#40)"
```

---

## Phase E — Wire-up + verification

### Task 8: Link impact page from device detail

**Files:**
- Modify: `apps/web/app/device/[name]/page.tsx`

**Step 1:** Confirm the device-detail page either already links to `/impact/...` or locate the spot that logically should (per #39 out-of-scope note, the link is rendered and 404s until this issue lands). Grep first:

Run: `grep -n "impact" apps/web/app/device/\\[name\\]/page.tsx`

If no link exists, add a single `<Link href={\`/impact/${encodeURIComponent(name)}\`}>Impact</Link>` into the page header action row beside the existing neighbors/downstream links. If the link already exists, verify the href format matches our route param.

**Step 2:** Run full web test suite.

Run: `pnpm --filter web test -- --run && pnpm --filter web test:int -- --run`
Expected: all green.

**Step 3: Commit (only if a link was added)**

```bash
git add apps/web/app/device/[name]/page.tsx
git commit -m "feat: surface impact link on device detail header (#40)"
```

### Task 9: Playwright E2E — seed + click-through

**Files:**
- Create: `apps/web/e2e/impact.spec.ts` (or nearest sibling — check existing e2e dir layout)
- Modify: e2e seed file if there is a central fixture

**Step 1:** Follow the pattern in the closest existing spec (e.g. `apps/web/e2e/downstream.spec.ts` if present, else `device-detail.spec.ts`). Seed a minimal UPE→CSG→RAN chain with `E2E-` prefix, navigate to `/impact/E2E-UPE`, assert the table contains the CSG + RAN, and click a row to verify it lands on `/device/E2E-CSG`.

**Step 2:** Run: `pnpm --filter web test:e2e -- impact.spec.ts` (requires the compose stack — run `docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait` first if not already running).

Expected: spec passes. If the compose stack is not available in the current session, skip this task and note it in the PR description — CI runs it.

**Step 3: Commit**

```bash
git add apps/web/e2e/impact.spec.ts
git commit -m "test(e2e): /impact page click-through (#40)"
```

### Task 10: Full verification

**Files:** none

**Step 1:** Lint + typecheck + unit + int — fresh, no cache.

Run:
```
pnpm --filter @tsm/db build
pnpm -r typecheck
pnpm --filter web lint
pnpm --filter web test -- --run
pnpm --filter web test:int -- --run
```
Expected: all green, no new warnings introduced.

**Step 2:** Manual smoke against the dev stack if available.

```
docker compose up -d --wait
open https://localhost/impact/<seeded-device>
```

Visually confirm:
- Summary badges render with role colors
- Table shows hostname, role, site, vendor, hops
- Toggle `include_transport` round-trips via URL (checkbox state survives form submit)
- CSV link downloads a file named `impact-<device>.csv` with header `name,role,level,site,vendor,hops`
- Unknown device shows the red not-found panel

**Step 3:** Close the loop — REQUIRED SUB-SKILL: superpowers:verification-before-completion. Record fresh output of the full test suite in the PR description.

---

## Commit sequence (expected final state)

```
test: zod schemas for runImpact (#40)
feat: runImpact resolver — flat rows with hops + vendor (#40)
test: include_transport toggles MW visibility in runImpact (#40)
test: start_not_found + isolated-node cases (#40)
feat: too_large response when total > HARD_CAP (#40)
feat: /api/impact/csv endpoint with formula-safe cells (#40)
feat: /impact/[deviceId] page — summary + table + too-large fallback (#40)
feat: surface impact link on device detail header (#40)   # if applicable
test(e2e): /impact page click-through (#40)               # if stack available
```

Final PR references `Closes #40`. Parent PRD #29.
