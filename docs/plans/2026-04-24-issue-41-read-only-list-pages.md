# Read-Only List Pages — `/core`, `/analytics`, `/summary/[role]` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or executing-plans) to implement this plan task-by-task.

**Issue:** #41 — S23: Read-only list pages — /core, /analytics, /summary/[role] (bundled)

**Parent PRD:** #29

**Goal:** Ship three v2 read-only list pages that share one query shape (role/level-filtered `:Device` list with pagination, sortable columns, CSV export) plus a thin per-page wrapper for the page-specific twist (grouping by site for `/core`; fanout ordering for `/analytics`; role parameter for `/summary/[role]`).

**Architecture:**

- One shared resolver `apps/web/lib/device-list.ts` — `parseDeviceListQuery` (Zod) + `runDeviceList` (Neo4j). Three query modes: `byRole`, `byLevel`, `byFanout`. Returns `{ rows, total, page, pageSize }`. Server-side pagination + sort. **Hard cap** on `limit`/`pageSize` to bound result size. No role/level trust from user input — every filter is Zod-validated against a small allowlist.
- One shared CSV route `apps/web/app/api/devices/list/csv/route.ts` — same Zod schema, no page cap (streams the full filtered set up to a safety hard cap, e.g. 100k). Reuses `csvRow` + `sanitizeFilename`.
- One shared presentational component `apps/web/components/RoleFilteredTable.tsx` — renders rows, sort-link headers, pagination controls, CSV-link button. Stateless; the page drives data + URL.
- Page wrappers:
  - `apps/web/app/summary/[role]/page.tsx` — validates `role` (case-sensitive match against a role allowlist; 404 on miss), calls `runDeviceList({ mode: "byRole", role })`, renders `<RoleFilteredTable>`.
  - `apps/web/app/analytics/page.tsx` — reads `?role=X&limit=N`, calls `runDeviceList({ mode: "byFanout", role?, limit })`, renders `<RoleFilteredTable>` with an extra `Fanout` column.
  - `apps/web/app/core/page.tsx` — calls `runDeviceList({ mode: "byLevel", level: 1, pageSize: 500 })`, groups rows by `site` in-memory, renders one `<RoleFilteredTable>` per site group; for sites with >1 core, renders a small "cluster" chip linking to `/topology?site=<name>` (the S17 ClusterNode canvas already lives there). In-page inline cluster rendering is **deferred** — the link is the MVP carrier.

**Role allowlist:** derived at runtime by reading `config/hierarchy.yaml` once at module load (fail-fast Zod schema is already defined in the ingestor — we duplicate the minimal schema in web to avoid pulling the ingestor package in). The union of all `levels[*].roles` plus the `unknown_label` is the allowlist. This keeps role validation config-driven and survives hierarchy edits without code changes. Cache the parse in module scope — refreshes on server restart (acceptable; matches the ingestor's "read fresh at start of run" convention).

**Tech stack:** Next.js 14 server components, Neo4j driver via `@/lib/neo4j`, Zod, Tailwind, `@/lib/csv` for export, Vitest + testcontainers for integration, Playwright for E2E.

**Acceptance criteria (issue #41):**

- [ ] `/core` lists every `level=1` device; groups render by site
- [ ] `/analytics?role=RAN&limit=20` returns exactly 20 RAN devices sorted by fanout desc
- [ ] `/summary/GPON` shows all GPON devices; `/summary/Nonsense` → 404
- [ ] All three pages paginate, sort, and CSV-export via shared `RoleFilteredTable`
- [ ] Playwright E2E: click a row in `/analytics` → lands on `/devices/[node]`
- [ ] No regression in existing test suites

**Out of scope (explicitly deferred):**

- Inline graph canvas on `/core` (linked out to `/topology?site=X` instead — S17's view already lives there).
- Server-side search filter on the table (not in AC; future issue).
- Saved-views integration (`kind: "list"`) — not in AC.
- Deep fanout caching — the fanout query does a single aggregation; if slow, a future issue materializes `fanout` on `:Device`.

**Note on the issue's `/devices/[node]` reference:** The codebase standard (set by #39) is singular `/device/[name]`. Row links go to `/device/${encodeURIComponent(name)}`. The Playwright spec asserts navigation to that canonical URL.

---

## Pre-flight

### Task 0: Branch + clean baseline

**Files:** none

**Step 1:** Verify branch.

Run: `git branch --show-current`
Expected: `feat/issue-41-read-only-list-pages`. Unrelated `M CLAUDE.md` is allowed — do NOT stage it.

**Step 2:** Build `@tsm/db` (required before typecheck/tests pick up any new symbol).

Run: `pnpm --filter @tsm/db build`
Expected: clean build.

**Step 3:** Baseline tests green.

Run: `pnpm --filter web test -- --run`
Expected: all pass. Record the count in a scratch note. If red, stop and surface.

---

## Phase A — Role allowlist helper

**Goal:** A web-side helper that loads `config/hierarchy.yaml` once and exposes `isKnownRole(role)` + `getAllRoles()`. Pure, synchronous, cached.

### Task A1: Failing unit test for role allowlist

**Files:**
- Test: `apps/web/test/role-allowlist.test.ts` (create)

**Step 1:** Write:

```ts
import { describe, it, expect } from "vitest";
import { isKnownRole, getAllRoles } from "@/lib/role-allowlist";

describe("role allowlist (from config/hierarchy.yaml)", () => {
  it("returns true for every canonical role in the shipped hierarchy", () => {
    const roles = getAllRoles();
    expect(roles).toEqual(
      expect.arrayContaining(["CORE", "UPE", "CSG", "GPON", "SW", "MW", "RAN", "PTP", "PMP", "Customer"]),
    );
  });

  it("is case-sensitive: 'ran' is unknown, 'RAN' is known", () => {
    expect(isKnownRole("RAN")).toBe(true);
    expect(isKnownRole("ran")).toBe(false);
  });

  it("Unknown (the hierarchy's unknown_label) is a valid role for queries", () => {
    expect(isKnownRole("Unknown")).toBe(true);
  });

  it("Nonsense rejects", () => {
    expect(isKnownRole("Nonsense")).toBe(false);
  });
});
```

**Step 2:** Run `pnpm --filter web test -- --run role-allowlist`
Expected: FAIL — module missing.

**Step 3:** Commit the test alone:
```bash
git add apps/web/test/role-allowlist.test.ts
git commit -m "test: failing role-allowlist tests (#41)"
```

### Task A2: Implement role-allowlist lib

**Files:**
- Create: `apps/web/lib/role-allowlist.ts`

**Step 1:** Implement:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const Schema = z.object({
  levels: z.array(
    z.object({ level: z.number(), label: z.string(), roles: z.array(z.string().min(1)).min(1) }),
  ).min(1),
  unknown_label: z.string().min(1).default("Unknown"),
});

function resolveConfigPath(): string {
  // Mirror ingestor: RESOLVER_CONFIG_DIR overrides; fall back to repo-root config/.
  const dir = process.env.RESOLVER_CONFIG_DIR;
  if (dir) return path.join(dir, "hierarchy.yaml");
  // apps/web/lib/role-allowlist.ts → repo-root/config/hierarchy.yaml
  return path.resolve(process.cwd(), "..", "..", "config", "hierarchy.yaml");
}

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  const raw = readFileSync(resolveConfigPath(), "utf8");
  const parsed = Schema.parse(parseYaml(raw));
  const roles = new Set<string>();
  for (const lvl of parsed.levels) for (const r of lvl.roles) roles.add(r);
  roles.add(parsed.unknown_label);
  cache = roles;
  return cache;
}

export function getAllRoles(): string[] {
  return [...load()].sort();
}

export function isKnownRole(role: string): boolean {
  return load().has(role);
}

/** Test-only: reset cache so subsequent load re-reads the file. */
export function __resetRoleCache(): void {
  cache = null;
}
```

**Step 2:** Run `pnpm --filter web test -- --run role-allowlist`
Expected: PASS.

**Step 3:** Run `pnpm --filter web typecheck`
Expected: clean.

**Step 4:** Commit:
```bash
git add apps/web/lib/role-allowlist.ts
git commit -m "feat(web): role allowlist loader from hierarchy.yaml (#41)"
```

---

## Phase B — `device-list` resolver (pagination + sort + CSV surface)

**Goal:** Shared Zod-validated query + Neo4j resolver serving all three pages + the CSV route.

### Task B1: Failing unit tests for `parseDeviceListQuery`

**Files:**
- Test: `apps/web/test/device-list.test.ts` (create)

**Step 1:** Write tests covering:
- Default pagination (`page=1`, `pageSize=50`).
- `pageSize` clamps to max `500`.
- `sort` only accepts `name|role|level|site|vendor|fanout`; anything else → throws.
- `dir` default `asc`; only `asc|desc`.
- `mode=byRole` requires `role` and rejects unknown roles (uses `isKnownRole`).
- `mode=byLevel` requires `level` from a numeric allowlist `{1,2,3,3.5,4,5,99}`.
- `mode=byFanout` optional `role`, optional `limit` default 20, max 200.

Skeleton:

```ts
import { describe, it, expect } from "vitest";
import { parseDeviceListQuery } from "@/lib/device-list";

describe("parseDeviceListQuery", () => {
  it("defaults page=1 pageSize=50 sort=name dir=asc in byRole mode", () => {
    const q = parseDeviceListQuery({ mode: "byRole", role: "GPON" });
    expect(q).toMatchObject({ mode: "byRole", role: "GPON", page: 1, pageSize: 50, sort: "name", dir: "asc" });
  });
  it("rejects unknown role", () => {
    expect(() => parseDeviceListQuery({ mode: "byRole", role: "Nonsense" })).toThrow();
  });
  it("byLevel only accepts canonical level numbers", () => {
    expect(() => parseDeviceListQuery({ mode: "byLevel", level: 1 })).not.toThrow();
    expect(() => parseDeviceListQuery({ mode: "byLevel", level: 7 })).toThrow();
  });
  it("byFanout clamps limit to 200", () => {
    const q = parseDeviceListQuery({ mode: "byFanout", limit: "9999" });
    expect(q.mode === "byFanout" && q.limit).toBe(200);
  });
  it("pageSize clamped to 500", () => {
    const q = parseDeviceListQuery({ mode: "byRole", role: "GPON", pageSize: "10000" });
    expect(q.pageSize).toBe(500);
  });
  it("rejects sort=dropDatabase", () => {
    expect(() => parseDeviceListQuery({ mode: "byRole", role: "GPON", sort: "dropDatabase" })).toThrow();
  });
});
```

**Step 2:** Run `pnpm --filter web test -- --run device-list`
Expected: FAIL — module missing.

**Step 3:** Commit:
```bash
git add apps/web/test/device-list.test.ts
git commit -m "test: failing device-list parser tests (#41)"
```

### Task B2: Implement `parseDeviceListQuery` (no Cypher yet)

**Files:**
- Create: `apps/web/lib/device-list.ts` (parser + types only for this task)

**Step 1:** Implement:

```ts
import { z } from "zod";
import { isKnownRole } from "@/lib/role-allowlist";

const CANONICAL_LEVELS = [1, 2, 3, 3.5, 4, 5, 99] as const;
const SORT_COLS = ["name", "role", "level", "site", "vendor", "fanout"] as const;

const Base = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(SORT_COLS).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const ByRole = Base.extend({
  mode: z.literal("byRole"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role"),
});

const ByLevel = Base.extend({
  mode: z.literal("byLevel"),
  level: z.coerce.number().refine(
    (n) => CANONICAL_LEVELS.includes(n as (typeof CANONICAL_LEVELS)[number]),
    "unknown_level",
  ),
});

const ByFanout = Base.extend({
  mode: z.literal("byFanout"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

export const DeviceListQuery = z.discriminatedUnion("mode", [ByRole, ByLevel, ByFanout]);
export type DeviceListQuery = z.infer<typeof DeviceListQuery>;

export function parseDeviceListQuery(input: unknown): DeviceListQuery {
  return DeviceListQuery.parse(input);
}

// `runDeviceList` lands in B4 — stub for the type export now.
export type DeviceListRow = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  vendor: string | null;
  fanout?: number;
};

export type DeviceListResult = {
  rows: DeviceListRow[];
  total: number;
  page: number;
  pageSize: number;
};
```

**Step 2:** Build `@tsm/db` is not required here (no cross-workspace symbol). Run:

```
pnpm --filter web test -- --run device-list
pnpm --filter web typecheck
```

Expected: parser tests PASS, typecheck clean.

**Step 3:** Commit:
```bash
git add apps/web/lib/device-list.ts
git commit -m "feat(web): device-list query schema (#41)"
```

### Task B3: Integration test for `runDeviceList` (testcontainers)

**Files:**
- Test: `apps/web/test/device-list.int.test.ts` (create)

**Step 1:** Mirror the pattern in `apps/web/test/downstream.int.test.ts`: spin a Neo4j testcontainer, seed ~30 synthetic devices across roles (`CORE`, `UPE`, `GPON`, `RAN`, …) with a handful of `:CONNECTS_TO` edges to exercise fanout, then assert:

- `byRole` with `role=GPON` returns only GPON devices, paginates (`page=2, pageSize=5` returns rows 6–10), honors `sort=site dir=desc`.
- `byLevel` with `level=1` returns only level-1 devices.
- `byFanout` with `limit=3` returns the 3 highest-fanout devices, fanout desc, `row.fanout` populated.
- `byFanout` with `role=RAN, limit=2` restricts to RAN and returns the 2 highest-fanout RANs.
- Invariant: `total` matches the full filtered count regardless of `page/pageSize`.

Use the shared seed helper already in `apps/web/test/` (grep `seedDevices` or similar — `downstream.int.test.ts` is the reference).

**Step 2:** Run `pnpm --filter web test:int -- --run device-list`
Expected: FAIL — `runDeviceList` not implemented yet.

**Step 3:** Commit:
```bash
git add apps/web/test/device-list.int.test.ts
git commit -m "test: failing device-list int tests (#41)"
```

### Task B4: Implement `runDeviceList` (Cypher)

**Files:**
- Modify: `apps/web/lib/device-list.ts` (add `runDeviceList` at bottom)

**Step 1:** Implement three branch bodies:

- `byRole` → `MATCH (d:Device {role: $role}) …`
- `byLevel` → `MATCH (d:Device) WHERE d.level = $level …`
- `byFanout` → `MATCH (d:Device) <optional role filter> OPTIONAL MATCH (d)-[:CONNECTS_TO]-() WITH d, count(*) AS fanout ORDER BY fanout DESC LIMIT $limit RETURN …`

**Cypher rules (from project CLAUDE.md):**

- **Never** filter by label (`:CORE`, `:GPON`) — filter by `d.role = $role` or `d.level = $level`. Labels are config-driven; properties are stable.
- **Never** interpolate user input. `$role`, `$level`, `$limit`, `$skip`, `$pageSize` are all parameters. `sort`/`dir` come from Zod enums, so **they** are safe to interpolate — validated by the enum, not concatenated from raw input.
- `sort=fanout` only makes sense in `byFanout` mode; in other modes silently coerce to `name` (or reject — pick reject, stricter).

Sketch:

```ts
export async function runDeviceList(q: DeviceListQuery): Promise<DeviceListResult> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const skip = (q.page - 1) * q.pageSize;
    const dir = q.dir === "desc" ? "DESC" : "ASC";

    if (q.mode === "byFanout") {
      const roleClause = q.role ? "WHERE d.role = $role" : "";
      const res = await session.run(
        `MATCH (d:Device) ${roleClause}
         OPTIONAL MATCH (d)-[r:CONNECTS_TO]-()
         WITH d, count(r) AS fanout
         ORDER BY fanout DESC, d.name ASC
         LIMIT $limit
         RETURN d { .name, .role, .level, .site, .vendor } AS node, fanout`,
        { role: q.role, limit: q.limit },
      );
      const rows = res.records.map((rec) => {
        const n = rec.get("node") as Record<string, unknown>;
        return {
          name: String(n.name),
          role: String(n.role ?? "Unknown"),
          level: toNum(n.level ?? 0),
          site: toStrOrNull(n.site),
          vendor: toStrOrNull(n.vendor),
          fanout: toNum(rec.get("fanout")),
        };
      });
      return { rows, total: rows.length, page: 1, pageSize: rows.length };
    }

    const filterClause =
      q.mode === "byRole"
        ? "WHERE d.role = $role"
        : "WHERE d.level = $level";

    // ORDER BY is safe to interpolate — `sort` is a Zod-enum literal.
    const sortCol = q.sort === "fanout" ? "name" : q.sort; // guard: fanout only valid in byFanout
    const [listRes, countRes] = await Promise.all([
      session.run(
        `MATCH (d:Device) ${filterClause}
         RETURN d { .name, .role, .level, .site, .vendor } AS node
         ORDER BY d.${sortCol} ${dir}, d.name ASC
         SKIP $skip LIMIT $pageSize`,
        { role: (q as any).role, level: (q as any).level, skip, pageSize: q.pageSize },
      ),
      session.run(
        `MATCH (d:Device) ${filterClause} RETURN count(d) AS total`,
        { role: (q as any).role, level: (q as any).level },
      ),
    ]);

    const rows = listRes.records.map((rec) => {
      const n = rec.get("node") as Record<string, unknown>;
      return {
        name: String(n.name),
        role: String(n.role ?? "Unknown"),
        level: toNum(n.level ?? 0),
        site: toStrOrNull(n.site),
        vendor: toStrOrNull(n.vendor),
      };
    });
    const total = toNum(countRes.records[0]!.get("total"));
    return { rows, total, page: q.page, pageSize: q.pageSize };
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
function toStrOrNull(v: unknown): string | null { return v == null ? null : String(v); }
```

(Add the `getDriver` import at the top of the file.)

**Step 2:** Run:

```
pnpm --filter web test -- --run device-list
pnpm --filter web test:int -- --run device-list
pnpm --filter web typecheck
```

Expected: all PASS.

**Step 3:** Commit:
```bash
git add apps/web/lib/device-list.ts
git commit -m "feat(web): runDeviceList resolver (byRole/byLevel/byFanout) (#41)"
```

---

## Phase C — `RoleFilteredTable` presentational component

**Goal:** One stateless component rendering rows + sort headers + pagination + CSV link. Server-component-friendly.

### Task C1: Failing component test

**Files:**
- Test: `apps/web/test/role-filtered-table.test.tsx` (create)

**Step 1:** Using `renderToStaticMarkup` (like `device-card.test.tsx`), assert:

- Renders a row per `rows` entry with a link `/device/<encoded>`.
- Header `<a>` for each sortable column sets `?sort=<col>&dir=asc|desc` (toggles dir if already active).
- Pagination: with `total=120, page=2, pageSize=50` renders Prev + Next with correct href.
- Optional `fanout` column renders only when any row has `fanout` defined.
- CSV link renders when `csvHref` prop is set; hidden otherwise.

**Step 2:** Ensure `apps/web/vitest.workspace.ts` unit-project globs cover `.test.tsx` and has `esbuild: { jsx: "automatic" }` — per project pitfall. If already covered by earlier test files in the repo, no change needed; just verify.

**Step 3:** Run `pnpm --filter web test -- --run role-filtered-table`
Expected: FAIL — component missing.

**Step 4:** Commit:
```bash
git add apps/web/test/role-filtered-table.test.tsx
git commit -m "test: failing RoleFilteredTable tests (#41)"
```

### Task C2: Implement `RoleFilteredTable`

**Files:**
- Create: `apps/web/components/RoleFilteredTable.tsx`

**Step 1:** Implement a server component taking:

```ts
type Props = {
  rows: DeviceListRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  /** Base URL for header-link / pagination hrefs, with any non-sort params kept. */
  baseHref: string;
  /** Query string merged into hrefs so role/limit/etc survive sort clicks. */
  carryParams: Record<string, string | undefined>;
  /** If set, a "Download CSV" button that preserves `carryParams`. */
  csvHref?: string;
  /** Columns shown; `fanout` is opt-in. */
  columns?: ReadonlyArray<"name" | "role" | "level" | "site" | "vendor" | "fanout">;
};
```

- Use `<RoleBadge role level>` for the role column (matches `/impact` look).
- Sort-link header: clicking toggles `dir` if `sort === col`, else sets `sort=col&dir=asc`.
- Pagination: Prev disabled on `page=1`; Next disabled when `page * pageSize >= total`. Show "Page X of Y (total T)".
- URL building: a small helper `buildHref(baseHref, carryParams, override)`. URL-encode everything. No client-side JS.

**Step 2:** Run `pnpm --filter web test -- --run role-filtered-table` → PASS. Run typecheck.

**Step 3:** Commit:
```bash
git add apps/web/components/RoleFilteredTable.tsx
git commit -m "feat(web): RoleFilteredTable component (#41)"
```

---

## Phase D — `/summary/[role]` page (simplest consumer)

### Task D1: Failing page render test

**Files:**
- Test: `apps/web/test/summary-page.test.tsx` (create)

**Step 1:** Two unit-level assertions around the page shell (mock `runDeviceList` via vi.mock like `impact-page.test.tsx` does):

- Renders the hostname + role badge for each row returned.
- Has a CSV link with `role=<role>` in the query.

Plus: a Next.js 404 test — call the page with an unknown role param and assert it throws / redirects to `notFound()`. Follow the pattern in `apps/web/app/device/[name]/not-found.tsx` if one exists.

**Step 2:** Run `pnpm --filter web test -- --run summary-page`
Expected: FAIL.

**Step 3:** Commit:
```bash
git add apps/web/test/summary-page.test.tsx
git commit -m "test: failing /summary/[role] page tests (#41)"
```

### Task D2: Implement `/summary/[role]/page.tsx`

**Files:**
- Create: `apps/web/app/summary/[role]/page.tsx`

**Step 1:** Shape:

```tsx
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import { parseDeviceListQuery, runDeviceList } from "@/lib/device-list";
import { isKnownRole } from "@/lib/role-allowlist";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";

export const dynamic = "force-dynamic";

export default async function SummaryByRolePage({
  params,
  searchParams,
}: {
  params: { role: string };
  searchParams: { [k: string]: string | undefined };
}) {
  await requireRole("viewer");
  const role = decodeURIComponent(params.role);
  if (!isKnownRole(role)) notFound();

  const q = parseDeviceListQuery({ mode: "byRole", role, ...searchParams });
  const result = await runDeviceList(q);

  const carry = { /* nothing extra to carry; role is in the URL path */ };
  const csvHref = `/api/devices/list/csv?mode=byRole&role=${encodeURIComponent(role)}&sort=${q.sort}&dir=${q.dir}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">{role} devices</h1>
      <p className="mt-1 text-sm text-slate-600">{result.total.toLocaleString()} total</p>
      <div className="mt-6">
        <RoleFilteredTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={q.sort}
          dir={q.dir}
          baseHref={`/summary/${encodeURIComponent(role)}`}
          carryParams={carry}
          csvHref={csvHref}
        />
      </div>
    </main>
  );
}
```

**Step 2:** Run `pnpm --filter web test -- --run summary-page` → PASS. Typecheck clean.

**Step 3:** Manual smoke via dev server is deferred to Phase H.

**Step 4:** Commit:
```bash
git add apps/web/app/summary/[role]/page.tsx
git commit -m "feat(web): /summary/[role] page (#41)"
```

---

## Phase E — `/analytics` page (fanout)

### Task E1: Failing page test

**Files:**
- Test: `apps/web/test/analytics-page.test.tsx` (create)

Assertions (mock `runDeviceList`):
- `/analytics?role=RAN&limit=3` calls `runDeviceList` with `{ mode: "byFanout", role: "RAN", limit: 3 }`.
- Rows render with a `Fanout` column showing the number.
- Row links go to `/device/${encodeURIComponent(name)}`.
- Unknown role in the query → shows an error panel (not 404, since `/analytics` is always reachable); Zod parse error is caught.

Run + commit failing test.

### Task E2: Implement `/analytics/page.tsx`

**Files:**
- Create: `apps/web/app/analytics/page.tsx`

**Step 1:** Similar skeleton to D2, but `mode: "byFanout"`, and pass `columns={["name","role","level","site","vendor","fanout"]}` to the table. Pagination is a no-op (byFanout returns a single bounded page), so hide the pagination UI — pass `pageSize === total` and let the component skip the nav. Filters:

- `?role=RAN` optional; show an `<input>` for it.
- `?limit=20` optional; show a `<select>` or `<input>` bounded 1–200.

**Step 2:** Wrap parse in try/catch; render an error panel on failure.

**Step 3:** Tests → PASS. Typecheck clean.

**Step 4:** Commit:
```bash
git add apps/web/app/analytics/page.tsx
git commit -m "feat(web): /analytics fanout page (#41)"
```

---

## Phase F — `/core` page (grouped by site)

### Task F1: Failing page test

**Files:**
- Test: `apps/web/test/core-page.test.tsx` (create)

Assertions (mock `runDeviceList` to return 7 cores across 3 sites, one site with 3 cores):
- One `<section>` per site (3 sections).
- Site with >1 core renders a "View cluster →" link to `/topology?site=<name>`.
- Site with 1 core does not render the cluster link.
- Each section has its own `<RoleFilteredTable>` rendering just that site's rows.

Run + commit failing test.

### Task F2: Implement `/core/page.tsx`

**Files:**
- Create: `apps/web/app/core/page.tsx`

**Step 1:** Skeleton:

```tsx
// …requireRole + parse + runDeviceList({ mode: "byLevel", level: 1, pageSize: 500 })
// Group rows by row.site ?? "(no site)".
// Render one section per site, sorted by site name.
// For sites with >1 core, render <Link href={`/topology?site=${encodeURIComponent(site)}`}>View cluster →</Link>.
```

**Step 2:** Tests → PASS. Typecheck clean.

**Step 3:** Commit:
```bash
git add apps/web/app/core/page.tsx
git commit -m "feat(web): /core grouped-by-site page (#41)"
```

---

## Phase G — Shared CSV route

### Task G1: Failing integration test

**Files:**
- Test: `apps/web/test/device-list-csv.int.test.ts` (create)

Mirror `apps/web/test/impact-csv.int.test.ts`:
- Seed the testcontainer Neo4j.
- GET `/api/devices/list/csv?mode=byRole&role=GPON` → header `Content-Type: text/csv`, `Content-Disposition` with sanitized filename `devices-byRole-GPON.csv`, body starts with the expected header row, subsequent rows match seeded GPON devices.
- GET with `mode=byRole&role=Nonsense` → 400.
- Formula-injection smoke: seed a device whose `name` starts with `=`; assert the emitted CSV cell is apostrophe-prefixed + quoted (delegates to `csvEscape` — assert by substring, not by reimplementing the rule).

Run + commit failing test.

### Task G2: Implement `/api/devices/list/csv/route.ts`

**Files:**
- Create: `apps/web/app/api/devices/list/csv/route.ts`

**Step 1:** Implementation:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseDeviceListQuery, runDeviceList } from "@/lib/device-list";
import { tryConsume } from "@/lib/rate-limit";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`devices-list-csv:${session.user.id}`, { capacity: 20, refillPerSec: 2 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "1" } });

  const input = Object.fromEntries(req.nextUrl.searchParams);
  let parsed;
  try { parsed = parseDeviceListQuery({ ...input, page: 1, pageSize: 500 /* max */ }); }
  catch { return NextResponse.json({ error: "invalid_query" }, { status: 400 }); }

  try {
    // For CSV we always want the full filtered set. Loop pages until exhausted.
    const all: Awaited<ReturnType<typeof runDeviceList>>["rows"] = [];
    const HARD_CAP = 100_000;
    let page = 1;
    const pageSize = 500;
    while (true) {
      const r = await runDeviceList({ ...parsed, page, pageSize } as typeof parsed);
      all.push(...r.rows);
      if (parsed.mode === "byFanout") break; // fanout returns single bounded page
      if (all.length >= r.total) break;
      if (all.length >= HARD_CAP) break;
      page += 1;
    }

    const cols = parsed.mode === "byFanout"
      ? ["name", "role", "level", "site", "vendor", "fanout"]
      : ["name", "role", "level", "site", "vendor"];
    const header = csvRow(cols);
    const body = all.map((r) => csvRow(cols.map((c) => (r as any)[c] ?? ""))).join("\n");
    const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;

    const ident = parsed.mode === "byRole" ? parsed.role
                : parsed.mode === "byLevel" ? `level-${parsed.level}`
                : `fanout${parsed.role ? `-${parsed.role}` : ""}`;
    const filename = sanitizeFilename(`devices-${parsed.mode}-${ident}.csv`);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    log("error", "devices_list_csv_failed", { error: err instanceof Error ? err.message : String(err), user: session.user.id });
    return NextResponse.json({ error: "list_failed" }, { status: 503 });
  }
}
```

**Step 2:** Run tests → PASS. Typecheck clean.

**Step 3:** Commit:
```bash
git add apps/web/app/api/devices/list/csv/route.ts
git commit -m "feat(web): shared /api/devices/list/csv route (#41)"
```

---

## Phase H — Playwright E2E + navigation

### Task H1: E2E — click a row on `/analytics` → device detail

**Files:**
- Create: `apps/web/e2e/analytics.spec.ts`

**Step 1:** Pattern: mirror `apps/web/e2e/` existing specs. The seed helper used by other specs (grep for `E2E-` fixtures) should already create a handful of connected devices. Add whatever incremental seed is needed (prefix `E2E-` per the project rule — never real hostnames).

Assertions:
- Navigate to `/analytics?role=RAN&limit=10`.
- Exactly 10 rows (or fewer if fixture has fewer; assert `>=1` minimum + specific fixture count).
- First row link click → URL is `/device/<encoded-first-row-name>`.
- Page title on the destination matches the clicked device name.

**Step 2:** Run `pnpm --filter web test:e2e -- analytics` (needs the compose stack up with CI overlay). Expected: PASS.

**Step 3:** Commit:
```bash
git add apps/web/e2e/analytics.spec.ts
git commit -m "test(e2e): /analytics row click → device detail (#41)"
```

### Task H2: Primary nav links

**Files:**
- Modify: whichever component renders the top nav (`apps/web/app/_components/nav.tsx` or similar — grep `nav` in `_components`). Add `/core`, `/analytics` as top-level items. Do NOT add `/summary/[role]` (it's parameterized; link from `/core` role badges instead if obvious, else leave for a future issue).

**Step 1:** Minimal diff. If nav already has a "Sites" or "Devices" dropdown, slot these in there.

**Step 2:** Run `pnpm --filter web test -- --run` + typecheck.

**Step 3:** Commit:
```bash
git add apps/web/app/_components/<nav>.tsx
git commit -m "feat(web): add /core and /analytics to primary nav (#41)"
```

---

## Phase I — Verification

### Task I1: Full suite green

**Step 1:** Run:

```
pnpm --filter @tsm/db build
pnpm -r typecheck
pnpm --filter web test -- --run
pnpm --filter web test:int -- --run
pnpm -r lint
```

Expected: all green. Record counts. Diff against Pre-flight baseline — new tests only, no drop in passing count.

**Step 2:** Spin the compose stack + run E2E:

```
docker compose up -d --wait
pnpm --filter web test:e2e -- analytics
```

Expected: PASS.

**Step 3:** Manually smoke in a browser (per project rule — "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete"):

- `/core` — groups by site; sites with >1 core show "View cluster →" link.
- `/analytics?role=RAN&limit=20` — 20 rows, fanout-desc.
- `/summary/GPON` — table loads; pagination works; sort by site works.
- `/summary/Nonsense` — renders Next.js 404.
- CSV export from each page — downloads, opens in a spreadsheet without formula-injection artifacts.

Note any browser-only issues in the PR description.

### Task I2: Issue verification + PR

- Tick every AC on the issue with the verifying test name.
- PR title: `feat: read-only list pages — /core, /analytics, /summary/[role] (#41)`
- PR body: summary bullets + Closes #41 + parent PRD #29 + AC checklist + test-plan checklist.

---

## Follow-ups (do NOT land in this PR)

- Inline S17 cluster canvas on `/core` (deferred — link to `/topology?site=` is MVP).
- Saved-views `kind: "list"` covering these pages.
- Materialize `fanout` on `:Device` at ingest time if `/analytics` p50 > 1s on production scale (689k rows).
- Server-side free-text filter on the table.
