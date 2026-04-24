# Issue #58 — UX Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the visible UX skeleton of V2: two-row global nav, home dashboard with KPIs + freshness, canonical `/devices` list (fixes `/map` 404), `/isolations` view, map+topology split panel, and middleware env-gate for dev preview pages.

**Architecture:** One new ingestor stage mirrors V1's `app_isolations` into a new Postgres `isolations` table; the web layer reads it server-side and exposes the `/isolations` page. `/devices` extends the existing `DeviceListQuery` discriminated union with a `bySite` mode and reuses the existing `<SiteSelector>` (`apps/web/components/SiteSelector.tsx`) and `<RoleFilteredTable>` components. A new `<Nav>` server component is injected into `apps/web/app/layout.tsx` so every authenticated page renders it. Map/topology split-panel is built by composing existing `/map` + `/topology` client components under one `/map` page (the Leaflet map stays left, a ReactFlow ego-topology for the selected site renders right). Middleware adds a `NODE_ENV==='production' → 404` gate for `/design-preview` and `/graph-preview`.

**Tech Stack:** Next.js 14 App Router (server components), React, Neo4j (Cypher via existing lib helpers), Postgres (pg + node-pg-migrate), Vitest (unit + integration via testcontainers), Playwright E2E, ReactFlow, Leaflet + react-leaflet. No new runtime dependencies.

**References:**
- Issue: https://github.com/aghaPathan/telecom-service-mapping/issues/58
- Parent PRD: `docs/prd/v2-from-v1.md` §§ "Navigation / Information Architecture", "Modules to be built or modified"
- CLAUDE.md pitfalls apply throughout — especially: `react-leaflet` must stay behind `next/dynamic({ssr:false})`; role-label Cypher filters use `level`, not role label; `.tsx` tests require `vitest.workspace.ts` include globs.

---

## Pre-flight

Before starting Task 1:

1. **Branch check:** we're on branch `issue-58-ux-shell` (per Phase 5 of `/issues-to-complete`). If not, `git checkout -b issue-58-ux-shell`.
2. **Green baseline:** run `pnpm -r typecheck` and `pnpm --filter web test` (unit). Both must pass before any new code lands. If baseline red, STOP and surface.
3. **Re-read:** issue #58 acceptance criteria (`gh issue view 58`).

---

## Task 1: Postgres migration — `isolations` table

**Files:**
- Create: `packages/db/migrations/1700000000030_isolations.sql`
- Modify: none (migration runner picks up new file automatically via `node-pg-migrate`)

**Step 1: Write the migration**

```sql
-- up
CREATE TABLE IF NOT EXISTS isolations (
  id SERIAL PRIMARY KEY,
  device_name TEXT NOT NULL,
  data_source TEXT,
  vendor TEXT,
  connected_nodes TEXT[] NOT NULL DEFAULT '{}',
  load_dt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS isolations_device_name_idx ON isolations (device_name);
CREATE INDEX IF NOT EXISTS isolations_vendor_idx ON isolations (vendor);

-- down
DROP TABLE IF EXISTS isolations;
```

**Step 2: Verify migrations compile**

Run: `pnpm --filter @tsm/db build` (the db package exports the migration runner)
Expected: exits 0.

**Step 3: Commit**

```bash
git add packages/db/migrations/1700000000030_isolations.sql
git commit -m "feat: add isolations table migration (#58)"
```

---

## Task 2: Ingestor — `readIsolations` source helper

**Files:**
- Create: `apps/ingestor/src/source/isolations.ts`
- Create: `apps/ingestor/test/source-isolations.test.ts` (unit — zod shape only)

**Step 1: Write the failing test**

```typescript
// apps/ingestor/test/source-isolations.test.ts
import { describe, it, expect } from "vitest";
import { parseConnectedNodes } from "../src/source/isolations";

describe("parseConnectedNodes", () => {
  it("splits V1 semicolon-delimited string into array", () => {
    expect(parseConnectedNodes("A;B;C")).toEqual(["A", "B", "C"]);
  });
  it("returns empty array for null", () => {
    expect(parseConnectedNodes(null)).toEqual([]);
  });
  it("returns empty array for empty string", () => {
    expect(parseConnectedNodes("")).toEqual([]);
  });
  it("trims whitespace and drops empty tokens", () => {
    expect(parseConnectedNodes(" A ; ; B ")).toEqual(["A", "B"]);
  });
});
```

Run: `pnpm --filter ingestor test source-isolations -- --run`
Expected: FAIL (`parseConnectedNodes` not defined).

**Step 2: Write the implementation**

```typescript
// apps/ingestor/src/source/isolations.ts
import { Pool } from "pg";

export type SourceIsolationRow = {
  device_name: string;
  data_source: string | null;
  vendor: string | null;
  connected_nodes: string[];
};

export function parseConnectedNodes(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function readIsolations(sourceUrl: string): Promise<SourceIsolationRow[]> {
  const pool = new Pool({ connectionString: sourceUrl });
  try {
    const res = await pool.query<{
      device_name: string;
      data_source: string | null;
      vendor: string | null;
      connected_nodes: string | null;
    }>(
      `SELECT device_name, data_source, vendor, connected_nodes
         FROM app_isolations`
    );
    return res.rows.map((r) => ({
      device_name: r.device_name,
      data_source: r.data_source,
      vendor: r.vendor,
      connected_nodes: parseConnectedNodes(r.connected_nodes),
    }));
  } finally {
    await pool.end();
  }
}
```

Run: `pnpm --filter ingestor test source-isolations -- --run`
Expected: PASS.

**Step 3: Commit**

```bash
git add apps/ingestor/src/source/isolations.ts apps/ingestor/test/source-isolations.test.ts
git commit -m "feat: add isolations source reader (#58)"
```

---

## Task 3: Ingestor — `writeIsolations` Postgres stage + pipeline wiring

**Files:**
- Create: `apps/ingestor/src/isolations-writer.ts`
- Modify: `apps/ingestor/src/index.ts` (after sites read, before Neo4j write — new stage)
- Create: `apps/ingestor/test/isolations.int.test.ts` (testcontainers Postgres)

**Step 1: Write the failing integration test**

Mirror `apps/ingestor/test/lldp-source.int.test.ts` pattern: spin up Postgres, seed `isolations`-source fixture, call writer, assert rows land in `isolations` target.

```typescript
// apps/ingestor/test/isolations.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { writeIsolations } from "../src/isolations-writer";
import { migrate } from "@tsm/db";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:13").start();
  const url = container.getConnectionUri();
  pool = new Pool({ connectionString: url });
  await migrate(url);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("writeIsolations", () => {
  it("replaces all rows on each run (full-refresh semantics)", async () => {
    await writeIsolations(pool, [
      { device_name: "A", data_source: "huawei-ip", vendor: "huawei", connected_nodes: ["B", "C"] },
    ]);
    const first = await pool.query("SELECT device_name, connected_nodes FROM isolations");
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].connected_nodes).toEqual(["B", "C"]);

    await writeIsolations(pool, [
      { device_name: "X", data_source: "nokia-ip", vendor: "nokia", connected_nodes: [] },
    ]);
    const second = await pool.query("SELECT device_name FROM isolations");
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].device_name).toBe("X");
  });
});
```

Run: `pnpm --filter ingestor test isolations.int -- --run`
Expected: FAIL (writer missing).

**Step 2: Implement writer**

```typescript
// apps/ingestor/src/isolations-writer.ts
import type { Pool } from "pg";
import type { SourceIsolationRow } from "./source/isolations";

export async function writeIsolations(pool: Pool, rows: SourceIsolationRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE isolations");
    if (rows.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      rows.forEach((r, i) => {
        const off = i * 4;
        placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4})`);
        values.push(r.device_name, r.data_source, r.vendor, r.connected_nodes);
      });
      await client.query(
        `INSERT INTO isolations (device_name, data_source, vendor, connected_nodes)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

Run: `pnpm --filter ingestor test isolations.int -- --run`
Expected: PASS.

**Step 3: Wire into pipeline**

In `apps/ingestor/src/index.ts`, after the sites stage and before the Neo4j write, call `writeIsolations(targetPool, await readIsolations(config.DATABASE_URL_SOURCE))`. Wrap in try/catch that records a warning (`warnings.isolations_failed`) and continues — isolation ingestion must not fail the main run.

**Step 4: Run full ingestor tests**

Run: `pnpm --filter ingestor test -- --run`
Expected: all pass.

**Step 5: Commit**

```bash
git add apps/ingestor/src/isolations-writer.ts apps/ingestor/src/index.ts apps/ingestor/test/isolations.int.test.ts
git commit -m "feat: wire isolations source→postgres ingestion stage (#58)"
```

---

## Task 4: Web — `lib/isolations.ts` read helper

**Files:**
- Create: `apps/web/lib/isolations.ts`
- Create: `apps/web/test/isolations.test.ts` (unit — shape)
- Create: `apps/web/test/isolations.int.test.ts` (testcontainers)

**Step 1: Write the failing unit test**

```typescript
// apps/web/test/isolations.test.ts
import { describe, it, expect } from "vitest";
import { parseIsolationsQuery } from "@/lib/isolations";

describe("parseIsolationsQuery", () => {
  it("accepts optional vendor and device filters", () => {
    expect(parseIsolationsQuery({ vendor: "huawei", device: "UPE" })).toEqual({
      vendor: "huawei",
      device: "UPE",
      limit: 100,
    });
  });
  it("clamps limit to [1, 1000]", () => {
    expect(parseIsolationsQuery({ limit: "99999" }).limit).toBe(1000);
    expect(parseIsolationsQuery({ limit: "0" }).limit).toBe(1);
    expect(parseIsolationsQuery({ limit: "not-a-number" }).limit).toBe(100);
  });
});
```

**Step 2: Implement**

```typescript
// apps/web/lib/isolations.ts
import { z } from "zod";
import { getPgPool } from "@/lib/pg-pool";

export type IsolationRow = {
  device_name: string;
  data_source: string | null;
  vendor: string | null;
  connected_nodes: string[];
  neighbor_count: number;
  load_dt: Date;
};

const Query = z.object({
  vendor: z.string().trim().max(64).optional(),
  device: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).catch(100).default(100),
});
export type IsolationsQuery = z.infer<typeof Query>;

export function parseIsolationsQuery(input: Record<string, unknown>): IsolationsQuery {
  return Query.parse(input);
}

export async function listIsolations(q: IsolationsQuery): Promise<IsolationRow[]> {
  const pool = getPgPool();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.vendor) {
    params.push(q.vendor);
    clauses.push(`vendor ILIKE $${params.length}`);
  }
  if (q.device) {
    params.push(`%${q.device}%`);
    clauses.push(`device_name ILIKE $${params.length}`);
  }
  params.push(q.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT device_name, data_source, vendor, connected_nodes, load_dt
                 FROM isolations
                 ${where}
                 ORDER BY device_name
                 LIMIT $${params.length}`;
  const res = await pool.query(sql, params);
  return res.rows.map((r) => ({
    ...r,
    neighbor_count: Array.isArray(r.connected_nodes) ? r.connected_nodes.length : 0,
  }));
}
```

**Step 3: Write the failing integration test**

```typescript
// apps/web/test/isolations.int.test.ts
// Mirror apps/web/test/path.int.test.ts setup: testcontainers Postgres; migrate; seed isolations rows; call listIsolations; assert.
```

(Full integration test body follows the `path.int.test.ts` fixture pattern — seed three rows, filter by vendor, assert count and `neighbor_count` values.)

**Step 4: Run tests**

Run: `pnpm --filter web test isolations -- --run`
Expected: PASS (both unit + int).

**Step 5: Commit**

```bash
git add apps/web/lib/isolations.ts apps/web/test/isolations.test.ts apps/web/test/isolations.int.test.ts
git commit -m "feat: add isolations web read helper (#58)"
```

---

## Task 5: Web — `/isolations` page

**Files:**
- Create: `apps/web/app/isolations/page.tsx`
- Create: `apps/web/test/isolations-page.test.tsx`

**Step 1: Write the failing component test**

Snapshot/markup-assertion test following `apps/web/test/core-page.test.tsx` pattern: mock `listIsolations` to return 2 rows; renderToStaticMarkup the page output; assert heading "Isolations", column "Neighbors", and numeric `2` (neighbor count) are in the HTML.

**Step 2: Implement the page**

```tsx
// apps/web/app/isolations/page.tsx
import { requireRole } from "@/lib/rbac";
import { listIsolations, parseIsolationsQuery } from "@/lib/isolations";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function IsolationsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireRole("viewer");
  const q = parseIsolationsQuery(searchParams as Record<string, unknown>);
  const rows = await listIsolations(q);
  return (
    <main className="container">
      <h1>Isolations</h1>
      <form className="filters" method="get">
        <input name="device" defaultValue={q.device ?? ""} placeholder="device name" />
        <input name="vendor" defaultValue={q.vendor ?? ""} placeholder="vendor" />
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead>
          <tr><th>Device</th><th>Vendor</th><th>Data source</th><th>Neighbors</th><th>Last sync</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.device_name}>
              <td><a href={`/device/${encodeURIComponent(r.device_name)}`}>{r.device_name}</a></td>
              <td>{r.vendor ?? "—"}</td>
              <td>{r.data_source ?? "—"}</td>
              <td title={r.connected_nodes.join(", ")}>{r.neighbor_count}</td>
              <td>{r.load_dt.toISOString().slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

**Step 3: Run tests**

Run: `pnpm --filter web test isolations-page -- --run`
Expected: PASS.

**Step 4: Commit**

```bash
git add apps/web/app/isolations/page.tsx apps/web/test/isolations-page.test.tsx
git commit -m "feat: add /isolations page (#58)"
```

---

## Task 6: Web — `bySite` mode in `device-list.ts`

**Files:**
- Modify: `apps/web/lib/device-list.ts` (add `BySite` to union, extend `parseDeviceListQuery`, add Cypher branch in `runDeviceList`)
- Modify: `apps/web/test/device-list.test.ts`
- Modify: `apps/web/test/device-list.int.test.ts`

**Step 1: Extend tests first (failing)**

Add unit case: `parseDeviceListQuery({ mode: "bySite", site: "JED", limit: 50 })` returns a valid `BySite` shape. Add integration case: seed 3 devices with `site: "JED"` and 2 with `site: "RUH"`; call `runDeviceList({mode:"bySite", site:"JED", ...})`; assert 3 rows.

**Step 2: Implement**

- Add `type BySite = { mode: "bySite"; site: string; limit: number; offset: number }` to the discriminated union.
- Zod validation: `site: z.string().trim().min(1).max(64)`.
- New Cypher branch: `MATCH (d:Device {site: $site}) RETURN d.name, d.role, d.level, d.site, d.vendor ORDER BY d.role, d.name SKIP $offset LIMIT $limit`.
- Count query: `MATCH (d:Device {site: $site}) RETURN count(d) AS total`.
- Keep the dual-session pattern (see existing comment at `device-list.ts` ~line 131).

**Step 3: Run tests**

Run: `pnpm --filter web test device-list -- --run`
Expected: PASS.

**Step 4: Commit**

```bash
git add apps/web/lib/device-list.ts apps/web/test/device-list.test.ts apps/web/test/device-list.int.test.ts
git commit -m "feat: add bySite mode to device-list query (#58)"
```

---

## Task 7: Web — `/devices` page + CSV handler

**Files:**
- Create: `apps/web/app/devices/page.tsx`
- Modify: `apps/web/app/api/devices/list/csv/route.ts` (add `bySite` support — the mode enum in the handler)
- Create: `apps/web/test/devices-page.test.tsx`

**Step 1: Write the failing page test**

Snapshot: with `searchParams.site = "JED"`, mock `runDeviceList`, assert the page renders the device table, the SiteSelector prefilled with JED, and a CSV-export link containing `mode=bySite&site=JED`.

**Step 2: Implement the page**

Pattern closely follows `apps/web/app/core/page.tsx` but with:
- `SiteSelector` at the top (client component, already exists).
- Role/vendor/domain `<select>`s (GET form) alongside site filter.
- When no site provided: render a helper message ("Pick a site or choose a role") rather than dumping all devices.
- When site provided: call `runDeviceList({ mode: "bySite", site, limit: 500 })` and render via `<RoleFilteredTable>`.
- CSV link points to `/api/devices/list/csv?mode=bySite&site=...`.

**Step 3: Extend the CSV handler**

Accept `mode=bySite` + `site=` params, forward to `runDeviceList`, stream CSV with existing `csvEscape` + `sanitizeFilename`.

**Step 4: Run tests**

Run: `pnpm --filter web test devices -- --run`
Expected: PASS.

**Step 5: Verify the `/map` 404 is fixed**

Run: `pnpm --filter web test:int -- map` (or add a new e2e assertion in Task 12). The existing `map-client.tsx` link `href="/devices?site=JED"` now resolves.

**Step 6: Commit**

```bash
git add apps/web/app/devices/page.tsx apps/web/app/api/devices/list/csv/route.ts apps/web/test/devices-page.test.tsx
git commit -m "feat: add /devices canonical list, fixes /map 404 (#58)"
```

---

## Task 8: Web — `<Nav>` component + wire into layout

**Files:**
- Create: `apps/web/app/_components/nav.tsx`
- Modify: `apps/web/app/layout.tsx` (render `<Nav />` in header)
- Create: `apps/web/test/nav.test.tsx`

**Step 1: Write the failing component test**

```tsx
// apps/web/test/nav.test.tsx
// Mock session {role:"viewer"}: assert row-1 links are present (/, /devices, /core, /topology, /impact, /map, /analytics, /isolations, /ingestion) AND row-2 (/admin/*) is NOT present.
// Mock session {role:"admin"}: assert row-2 admin links ARE present (/admin/users, /admin/views, /admin/audit).
// Mock no session: component returns null / nothing.
```

**Step 2: Implement `<Nav>`**

```tsx
// apps/web/app/_components/nav.tsx
import Link from "next/link";
import type { Session } from "@/lib/session";

type Props = { session: Session | null };

const ROW1 = [
  { href: "/", label: "Home" },
  { href: "/devices", label: "Devices" },
  { href: "/core", label: "Core" },
  { href: "/topology", label: "Topology" },
  { href: "/impact", label: "Impact" },
  { href: "/map", label: "Map" },
  { href: "/analytics", label: "Analytics" },
  { href: "/isolations", label: "Isolations" },
  { href: "/ingestion", label: "Ingestion" },
];

const ROW2_ADMIN = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/audit", label: "Audit" },
];

export function Nav({ session }: Props) {
  if (!session) return null;
  const isAdmin = session.user.role === "admin";
  return (
    <nav aria-label="Primary" className="app-nav">
      <ul className="app-nav__row">
        {ROW1.map((i) => (
          <li key={i.href}><Link href={i.href}>{i.label}</Link></li>
        ))}
      </ul>
      {isAdmin && (
        <ul className="app-nav__row app-nav__row--admin" aria-label="Admin">
          {ROW2_ADMIN.map((i) => (
            <li key={i.href}><Link href={i.href}>{i.label}</Link></li>
          ))}
        </ul>
      )}
    </nav>
  );
}
```

**Step 3: Wire into `layout.tsx`**

Add `<Nav session={session} />` inside the header, before the right-side session/views/logout cluster.

**Step 4: Run tests**

Run: `pnpm --filter web test nav -- --run`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/app/_components/nav.tsx apps/web/app/layout.tsx apps/web/test/nav.test.tsx
git commit -m "feat: add two-row global nav (#58)"
```

---

## Task 9: Web — home dashboard (vendor split + isolation count)

**Files:**
- Modify: `apps/web/lib/ingestion.ts` (add a `getHomeKpis()` helper, or new `apps/web/lib/kpis.ts`)
- Modify: `apps/web/app/page.tsx` (render KPIs above Omnibox)
- Create: `apps/web/test/home-page.test.tsx`
- Create: `apps/web/test/kpis.int.test.ts`

**Step 1: Write the failing KPI integration test**

Seed 3 devices (2 huawei, 1 nokia) and 4 isolations rows. Call `getHomeKpis()`. Assert `{ totalDevices: 3, byVendor: {huawei:2, nokia:1}, isolationCount: 4 }`.

**Step 2: Implement `getHomeKpis()`**

Cypher: `MATCH (d:Device) RETURN d.vendor AS vendor, count(*) AS n` + Postgres: `SELECT count(*) FROM isolations`. Execute in parallel with `Promise.all`.

**Step 3: Render on home page**

In `apps/web/app/page.tsx`, render a KPI strip (cards) above the Explore grid:
- Total devices.
- Per-vendor split (horizontal bar or table).
- Current isolation count (linked to `/isolations`).
- Last successful ingest (via existing `FreshnessBadge` — keep).

**Step 4: Run tests**

Run: `pnpm --filter web test home-page kpis -- --run`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/lib/kpis.ts apps/web/app/page.tsx apps/web/test/home-page.test.tsx apps/web/test/kpis.int.test.ts
git commit -m "feat: add home dashboard KPIs (#58)"
```

---

## Task 10: Web — `/map` split-panel merge with topology

**Files:**
- Modify: `apps/web/app/map/page.tsx` (introduce a right-panel for selected site topology)
- Modify: `apps/web/app/map/map-client.tsx` (emit a `site` URL param on click instead of linking directly to `/devices?site=`)
- Create: `apps/web/app/map/_components/site-topology-panel.tsx` (client component — reuses the existing topology canvas with mode=ego around the selected site)
- Create: `apps/web/test/map-page.test.tsx`

**Step 1: Design note**

The map stays a left-column Leaflet panel. The right column shows:
- If no site selected (no `?site=` param): an empty state with instructions.
- If `?site=X` selected: server-side fetch of ego-topology around site X (reuse `runEgoGraph` / `runCoreOverview` from `apps/web/lib/topology.ts`), then render inside a dynamically-imported `<SiteTopologyPanel>` client component (ReactFlow, `ssr:false`).

**Step 2: Write failing test**

With `searchParams.site = "JED"`, assert the page renders both a map container (`data-testid="map"`) AND a right panel (`data-testid="site-topology"`) with text referencing JED. Without `?site`, assert only the map renders and the right panel shows the empty state.

**Step 3: Implement**

Update `page.tsx` to read `searchParams.site`; if present, call the existing topology lib with `mode: "ego", name: <first device at this site>`; render `<SiteTopologyPanel>` next to `<MapClient>`.

For the map-click → site-select flow: `map-client.tsx` site popup now includes two links: "Open details (`/devices?site=X`)" and "Show topology (this panel)" which pushes `?site=X` to the URL.

**Step 4: Run tests**

Run: `pnpm --filter web test map-page -- --run`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/app/map/page.tsx apps/web/app/map/map-client.tsx apps/web/app/map/_components/site-topology-panel.tsx apps/web/test/map-page.test.tsx
git commit -m "feat: map+topology split-panel view (#58)"
```

---

## Task 11: Middleware — dev-page env gate

**Files:**
- Modify: `apps/web/middleware.ts`
- Modify: `apps/web/test/middleware.test.ts` (or create if absent)

**Step 1: Failing test**

Mock `NODE_ENV = "production"`; call middleware with path `/design-preview`; assert 404 response. Repeat for `/graph-preview`. Then mock `NODE_ENV = "development"`; assert pass-through (no rewrite to 404).

**Step 2: Implement**

Add to the top of the middleware function:

```typescript
if (process.env.NODE_ENV === "production") {
  const devOnly = ["/design-preview", "/graph-preview"];
  if (devOnly.some((p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(p + "/"))) {
    return new NextResponse("Not Found", { status: 404 });
  }
}
```

**Step 3: Run tests**

Run: `pnpm --filter web test middleware -- --run`
Expected: PASS.

**Step 4: Commit**

```bash
git add apps/web/middleware.ts apps/web/test/middleware.test.ts
git commit -m "feat: gate /design-preview and /graph-preview in production (#58)"
```

---

## Task 12: Playwright E2E — nav + /devices + /isolations smoke

**Files:**
- Create: `apps/web/e2e/nav.spec.ts`
- Create: `apps/web/e2e/devices.spec.ts`
- Create: `apps/web/e2e/isolations.spec.ts`

**Step 1: Auth fixture**

Reuse the existing pattern from `apps/web/e2e/auth.spec.ts`. Each spec signs in as the seeded viewer user, then exercises:

- `nav.spec.ts` — click each row-1 nav link; assert page lands without 404; admin row invisible.
- `devices.spec.ts` — from home, click "Devices"; land on `/devices`; select a site via `<SiteSelector>`; assert table rows render; click a device row → lands on `/device/[name]`. Also navigate to `/map`, click a site popup "Show devices" → lands on `/devices?site=…` with 200.
- `isolations.spec.ts` — click "Isolations" in nav; assert table renders; filter by vendor; results update.

**Step 2: Run E2E**

Run: `pnpm --filter web test:e2e -- nav devices isolations`
Expected: all pass against the compose stack.

**Step 3: Commit**

```bash
git add apps/web/e2e/nav.spec.ts apps/web/e2e/devices.spec.ts apps/web/e2e/isolations.spec.ts
git commit -m "test: e2e for nav, devices, isolations (#58)"
```

---

## Task 13: ADR — two-row nav IA

**Files:**
- Create: `docs/decisions/0003-nav-information-architecture.md`

**Step 1: Write the ADR**

Template mirroring `docs/decisions/0001-auth-stack.md`:
- Status: Accepted.
- Context: V2 previously had no global nav; six pages were orphans; PRD §IA mandates nav entries.
- Decision: two-row nav, row 1 always-visible (9 viewer+ links), row 2 admin-only (Users, Audit).
- Consequences: every new page must be added to `ROW1` (or `ROW2_ADMIN`) or explicitly marked dev-only; removing a page means also removing the nav entry.

**Step 2: Commit**

```bash
git add docs/decisions/0003-nav-information-architecture.md
git commit -m "docs: ADR for two-row nav IA (#58)"
```

---

## Task 14: Verification + PR

**Step 1: Full test suite**

```bash
pnpm -r typecheck
pnpm --filter ingestor test -- --run
pnpm --filter web test -- --run
pnpm --filter web test:int -- --run
pnpm --filter web test:e2e
```

All must pass. Fresh runs only — no cached "should work".

**Step 2: Acceptance-criteria traversal**

Re-read `gh issue view 58`. For each unchecked acceptance criterion, confirm concrete evidence (test name, file, or manual step). If any criterion is unverified, STOP — do not claim done.

**Step 3: Run `agent-pipeline` skill**

Per `/issues-to-complete` Full Path: invoke `agent-pipeline` (6 agents: architect → tests → review → security → simplify → docs) as a review gate before the PR.

**Step 4: Push + open PR**

```bash
git push -u origin issue-58-ux-shell
gh pr create --title "feat: UX shell — nav, home dashboard, /devices, /isolations, map split (#58)" --body-file <(cat <<'EOF'
## Summary
- Two-row global nav injected into layout; viewer+ row always, admin-only row for admins.
- Home page gains KPI strip (vendor split, isolation count) above the existing Omnibox + Explore grid.
- New `/devices` canonical list with site/role/vendor filters — fixes the `/map` site-popup 404.
- New `/isolations` page reading from new Postgres `isolations` table populated by the ingestor.
- `/map` now renders a split-panel: Leaflet map left, ego-topology of the selected site right.
- Middleware 404s `/design-preview` and `/graph-preview` in production.
- ADR 0003 documents the nav IA decision.

## Closes
Closes #58

## Parent PRD
#57

## Acceptance Criteria Verification
- [x] Two-row nav component — verified by `apps/web/test/nav.test.tsx` and `apps/web/e2e/nav.spec.ts`.
- [x] Home KPIs — verified by `kpis.int.test.ts` + `home-page.test.tsx`.
- [x] `/devices` with filters; `/map` 404 fixed — `devices-page.test.tsx`, `devices.int.test.ts`, `e2e/devices.spec.ts`.
- [x] `/isolations` neighbor counts as array length — `isolations.int.test.ts`, `e2e/isolations.spec.ts`.
- [x] `/map` split-panel — `map-page.test.tsx` + `e2e/devices.spec.ts`.
- [x] Dev-page 404 in production — `middleware.test.ts`.
- [x] ADR — `docs/decisions/0003-nav-information-architecture.md`.
- [x] No orphan API — no new `app/api/*` routes without UI callers (CSV handler extends existing route).

## Test Plan
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm --filter web test -- --run` green
- [ ] `pnpm --filter web test:int -- --run` green
- [ ] `pnpm --filter ingestor test -- --run` green
- [ ] `pnpm --filter web test:e2e` green against compose stack
- [ ] Manual: launch compose, log in, walk through each new nav entry

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

**Step 5: Monitor CI + merge**

Per `/issues-to-complete` Phase 6.5 — wait for checks, squash-merge, confirm `mergedAt` non-null, then Phase 7 (update issue body checkboxes + comment + cleanup).

---

## Risk log

- **`react-leaflet` SSR crash** — keep the Leaflet imports strictly inside a `ssr:false` dynamic component. CLAUDE.md has explicit pitfall text; honor it.
- **Neo4j dual-session requirement** — `bySite` count + list must run on two sessions (see existing comment in `device-list.ts`).
- **Source DB absent in CI** — `readIsolations` is called only by the ingestor. `INGEST_MODE=smoke` must continue to skip source reads (already does); confirm the new stage also skips under smoke.
- **SiteSelector reuse** — confirm the existing component accepts controlled value + onChange props before wiring into `/devices` filter form; if the component is display-only, extend it rather than creating a new one.
- **SW dynamic-leveling label collision** — no risk in this slice (we don't change hierarchy.yaml roles). Slice 2 handles that.
- **`isolations` table grows unbounded** — TRUNCATE-and-refill semantics keeps size equal to current upstream row count (V1 pattern).

---

## Done when

1. All 14 tasks' commits are on `issue-58-ux-shell`.
2. PR is green, merged, branch deleted.
3. Issue #58 is closed (auto via `Closes #58`).
4. Issue #58 acceptance-criteria checkboxes are all ticked.
5. Issue #58 has an "Implementation Complete" comment summarizing the work.

Proceed to `/issues-to-complete` Phase 8 (loop back for next unblocked issue).
