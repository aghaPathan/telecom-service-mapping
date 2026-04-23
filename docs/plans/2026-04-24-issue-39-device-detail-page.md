# Device Detail Page (/device/[name]) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Issue:** #39 — S21: Device detail page `/devices/[node]`

**Goal:** Replace the current `/device/[name]` page (a path-trace view) with a per-device **detail** page (header + 1-hop neighbors + inbound circuits), and relocate the existing path-trace content to a dedicated `/path/[name]` route.

**Architecture:**

- Human selected Option 2 (see issue comments on #39): the plural `/devices/[node]` wording in the spec loses to codebase convention (singular `/device/[name]` is hard-wired into PathRibbon/DeviceCard/omnibox/saved-views-url/8+ e2e specs). The detail page replaces the existing singular route's body; path-trace moves to `/path/[name]`.
- Data lives in Neo4j already. Detail queries are bounded single-hop (`MATCH (d)-[:CONNECTS_TO]-(n)`), so this page avoids the path.ts:277 island-fallback hang that plagues the current `/device/[name]`.
- `/service/[cid]` stays as-is (it's path-trace-only, no detail counterpart in scope). Only the device side is affected.
- Saved views of kind `path` with a device value now point at `/path/<device>`; service values unchanged.

**Tech stack:** Next.js 14 server components, Neo4j driver (same-process via `@/lib/neo4j`), Tailwind, existing S19 primitives (`components/DeviceCard.tsx`, `components/LevelBadge.tsx`), vitest (+ testcontainers for integration), Playwright for E2E.

**Acceptance criteria (issue #39):**

- [ ] Page loads for any known device name; unknown → 404
- [ ] Header shows role, level, site, vendor
- [ ] Neighbor table paginated at 50 rows; sortable by role/level
- [ ] Playwright E2E: seeded ICSG, assert neighbor list contains the seeded UPE + RAN
- [ ] Respects existing auth (`requireRole("viewer")`)

**Out of scope (tracked elsewhere, do NOT address here):**
- PRD #29 level-99 resolver bug
- path.ts:277 island-fallback perf TODO (#9-perf)
- `/impact/<name>` link target (built in #40; render the link, accept 404 until #40 lands)
- `/topology?around=<name>` deep-link (S18 already shipped; verify param name)

---

## Pre-flight

### Task 0: Confirm branch + clean starting state

**Files:** none

**Step 1:** Verify branch and working tree.

Run: `git branch --show-current && git status --short`
Expected: `feat/issue-39-device-detail-page`; only pre-existing `M CLAUDE.md` (do NOT touch it — it's unrelated user work that shipped onto this branch).

**Step 2:** Build the `@tsm/db` package once (required before any typecheck).

Run: `pnpm --filter @tsm/db build`
Expected: clean build, `packages/db/dist/` populated.

**Step 3:** Baseline: unit tests green on main-equivalent.

Run: `pnpm --filter web test -- --run`
Expected: all pass. Record count. If anything fails BEFORE our changes, stop and surface to human — don't build on broken ground.

---

## Phase A — Relocate path-trace to /path/[name] (preserve existing behavior first)

**Goal of this phase:** move path-trace content to its new home and update saved-views-url + e2e URLs BEFORE touching `/device/[name]` content. This keeps the tree shippable at every commit and lets tests stay green.

### Task A1: Create `/path/[name]/page.tsx` (copy of current /device/[name] page)

**Files:**
- Create: `apps/web/app/path/[name]/page.tsx`

**Step 1:** Write a failing UI test (no jsdom — use `renderToStaticMarkup`).

Create: `apps/web/test/path-device-page.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathView } from "@/app/_components/path-view";

// The /path/[name] page is a thin server component that wraps PathView — a
// render test on the child is enough here; full route wiring is covered by
// the e2e spec updates in Task A3.
describe("path-trace page (device)", () => {
  it("renders a 'no path' banner without crashing", () => {
    const html = renderToStaticMarkup(
      <PathView
        data={{ status: "no_path", reason: "island", unreached_at: null }}
      />,
    );
    expect(html).toContain("no path");
  });
});
```

Run: `pnpm --filter web test -- --run path-device-page`
Expected: FAIL with "Cannot find module" (PathView test OK, but confirm it parses).

Actually PathView already exists — if the child renders fine, this test passes immediately. Treat this test as a smoke assertion; the meaningful coverage for A1 is the e2e migration in A3.

**Step 2:** Create the new route — copy `apps/web/app/device/[name]/page.tsx` verbatim, rename testid `device-page-name` → `path-page-name`, and change `SaveViewButton` payload's value of `kind` in `query` to remain `"device"` (it's still a device-kind path trace).

Create: `apps/web/app/path/[name]/page.tsx`

```tsx
import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { runPath, type PathResponse } from "@/lib/path";
import { PathView } from "@/app/_components/path-view";
import { SaveViewButton } from "@/app/_components/save-view-button";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export default async function PathDevicePage({
  params,
}: {
  params: { name: string };
}) {
  const session = await requireRole("viewer");
  const name = decodeURIComponent(params.name);

  let result: PathResponse | null = null;
  try {
    result = await runPath({ kind: "device", value: name });
  } catch (err) {
    log("error", "path_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      kind: "device",
      value: name,
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1
          className="text-2xl font-semibold tracking-tight"
          data-testid="path-page-name"
        >
          {name}
        </h1>
        <div className="flex items-center gap-2">
          <SaveViewButton
            role={session.user.role}
            payload={{ kind: "path", query: { kind: "device", value: name } }}
          />
          <Link
            href={`/device/${encodeURIComponent(name)}`}
            data-testid="back-to-device"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50"
          >
            ← Device detail
          </Link>
        </div>
      </div>
      <div className="mt-6">
        {result ? (
          <PathView data={result} />
        ) : (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
            data-testid="path-error"
          >
            Path trace unavailable. Neo4j may be offline — try again in a moment.
          </div>
        )}
      </div>
    </main>
  );
}
```

**Step 3:** Typecheck.

Run: `pnpm --filter web typecheck`
Expected: PASS.

**Step 4:** Commit.

```bash
git add apps/web/app/path/[name]/page.tsx apps/web/test/path-device-page.test.tsx
git commit -m "feat(web): add /path/[name] route for device path-trace (#39)"
```

### Task A2: Update saved-views-url.ts — device path kind → /path

**Files:**
- Modify: `apps/web/lib/saved-views-url.ts:4-8`
- Modify: `apps/web/test/saved-views-url.test.ts` (update expected URLs)

**Step 1:** Update the failing test first (RED).

Edit `apps/web/test/saved-views-url.test.ts`: change the expected URL for `path/device` from `/device/E2E-SV-CSG` to `/path/E2E-SV-CSG` and from `/device/a%2Fb%20c` to `/path/a%2Fb%20c`. Leave the service test unchanged. Leave the downstream test unchanged.

Run: `pnpm --filter web test -- --run saved-views-url`
Expected: FAIL — real implementation still returns `/device/...`.

**Step 2:** Update the impl.

Edit `apps/web/lib/saved-views-url.ts`:

```ts
import type { ViewPayload } from "@/lib/saved-views";

export function savedViewToHref(payload: ViewPayload): string {
  if (payload.kind === "path") {
    const { kind, value } = payload.query;
    // Device-kind path → /path/<name>. Service-kind → /service/<cid>
    // (service page is already path-trace; no detail counterpart).
    const base = kind === "device" ? "/path" : "/service";
    return `${base}/${encodeURIComponent(value)}`;
  }
  const { device, include_transport, max_depth } = payload.query;
  const qs = new URLSearchParams({
    include_transport: String(include_transport),
    max_depth: String(max_depth),
  });
  return `/device/${encodeURIComponent(device)}/downstream?${qs.toString()}`;
}
```

Run: `pnpm --filter web test -- --run saved-views-url`
Expected: PASS.

**Step 3:** Commit.

```bash
git add apps/web/lib/saved-views-url.ts apps/web/test/saved-views-url.test.ts
git commit -m "refactor(web): saved-views device path kind targets /path/ (#39)"
```

### Task A3: Migrate e2e path-trace.spec.ts URLs

**Files:**
- Modify: `apps/web/e2e/path-trace.spec.ts:180, 228` (change `/device/${CUST}` and `/device/${ISLAND}` to `/path/${CUST}` / `/path/${ISLAND}`)
- Audit and, if any path-trace-specific assertions exist, modify: `apps/web/e2e/saved-views.spec.ts:168, 200, 214, 229` — only the assertions that test a SAVED VIEW of kind `path` for a device. Other assertions in that spec (omnibox deep-link etc.) may legitimately continue using `/device/`.

**Step 1:** Read the two specs end-to-end. For each `/device/<…>` usage, categorize as:
- (a) Intent is path-trace → flip to `/path/<…>`
- (b) Intent is device landing/omnibox click-through → LEAVE (those will now see detail; update test assertions accordingly in Phase B)
- (c) Intent is `/device/<…>/downstream` subroute → LEAVE UNCHANGED (downstream sub-route does not move)

Tag each line with the chosen category in your edit notes before editing. If ambiguous, stop and ask the human. (This is the exact place where silent misclassification produces bad commits.)

**Step 2:** Apply edits only to (a)-category lines. Update any `waitForURL(new RegExp(…/device/${NAME}$))` to match the new `/path/` URL.

**Step 3:** Do NOT run e2e yet — the compose CI overlay is required and full e2e is slow; defer until Phase B completes. Instead: `git diff` and eyeball.

**Step 4:** Commit.

```bash
git add apps/web/e2e/path-trace.spec.ts apps/web/e2e/saved-views.spec.ts
git commit -m "test(e2e): migrate device-kind path-trace URLs to /path/ (#39)"
```

---

## Phase B — Device detail page implementation

### Task B1: Data lib — `loadDevice(name)`

**Files:**
- Create: `apps/web/lib/device-detail.ts`
- Create: `apps/web/test/device-detail.int.test.ts`

**Step 1:** Write the failing integration test (mirror `path.int.test.ts` structure).

Create `apps/web/test/device-detail.int.test.ts` with a testcontainers seed of:
- 1 ICSG (Aggregation site-anchored customer agg, level 3, vendor "Huawei")
- 1 UPE (level 2) connected to ICSG
- 2 RAN (level 4) connected to ICSG
- 1 Service (`cid:"S1", mobily_cid:"M1"`) TERMINATES_AT source→ ICSG
- 1 unrelated island Device (to assert `loadDevice` doesn't bleed)

Test cases:
- `loadDevice("ICSG-1")` returns `{ name, role, level, site, vendor, domain }` matching the seeded values
- `loadDevice("does-not-exist")` returns `null`
- `loadNeighbors("ICSG-1", { page: 0, size: 50, sortBy: "role" })` returns 3 rows (UPE + 2 RAN), each with `{ name, role, level, a_if, b_if }`. Sorted by role ASC.
- `loadNeighbors` with `sortBy: "level"` returns UPE (2) first, then both RANs (4) — direction ASC
- `loadCircuits("ICSG-1")` returns 1 row with `{ cid: "S1", mobily_cid: "M1", role: "source" }`
- Pagination: seed 60 neighbors to ICSG-2 and assert page=0 returns 50, page=1 returns 10.

Run: `pnpm --filter web test:int -- --run device-detail`
Expected: FAIL, module not found.

**Step 2:** Implement `apps/web/lib/device-detail.ts`.

Signatures:

```ts
export type DeviceDetail = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  vendor: string | null;
  domain: string | null;
};

export type Neighbor = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  local_if: string | null;   // interface on THIS device's side
  remote_if: string | null;  // interface on the neighbor's side
  status: boolean | null;    // from CONNECTS_TO.status if persisted; null otherwise
};

export type Circuit = {
  cid: string;
  mobily_cid: string | null;
  role: string;              // "source" | "dest" etc, from TERMINATES_AT.role
};

export type NeighborSort = "role" | "level";

export async function loadDevice(name: string): Promise<DeviceDetail | null>;

export async function loadNeighbors(
  name: string,
  opts: { page: number; size: number; sortBy: NeighborSort },
): Promise<{ rows: Neighbor[]; total: number }>;

export async function loadCircuits(name: string): Promise<Circuit[]>;
```

Cypher sketches:

```cypher
// loadDevice
MATCH (d:Device {name: $name})
RETURN d { .name, .role, .level, .site, .vendor, .domain } AS node

// loadNeighbors — undirected traversal, face-aware interface picking
MATCH (d:Device {name: $name})-[r:CONNECTS_TO]-(n:Device)
WITH d, n, r,
     CASE WHEN startNode(r) = d THEN r.a_if ELSE r.b_if END AS local_if,
     CASE WHEN startNode(r) = d THEN r.b_if ELSE r.a_if END AS remote_if
RETURN n.name AS name, n.role AS role, n.level AS level, n.site AS site,
       local_if, remote_if, r.status AS status
ORDER BY
  CASE WHEN $sortBy = 'role' THEN n.role END ASC,
  CASE WHEN $sortBy = 'level' THEN n.level END ASC,
  n.name ASC
SKIP $skip LIMIT $size

// count
MATCH (d:Device {name: $name})-[:CONNECTS_TO]-(n:Device) RETURN count(DISTINCT n) AS total

// loadCircuits
MATCH (s:Service)-[t:TERMINATES_AT]->(d:Device {name: $name})
RETURN s.cid AS cid, s.mobily_cid AS mobily_cid, t.role AS role
ORDER BY s.cid ASC
```

Validate `page` (int ≥ 0) and `size` (int 1..200) with zod inline before interpolating SKIP/LIMIT. CLAUDE.md rule: "Don't try to parameterize `*1..N` in Cypher" doesn't apply here (no variable-length), but the zod-then-interpolate discipline for SKIP/LIMIT is the same posture. Actually — LIMIT/SKIP DO accept parameters in Neo4j 5; pass them as `neo4j.int(size)` via the driver. Prefer that to string interpolation.

Run the integration test: `pnpm --filter web test:int -- --run device-detail`
Expected: PASS.

**Step 3:** Commit.

```bash
git add apps/web/lib/device-detail.ts apps/web/test/device-detail.int.test.ts
git commit -m "feat(web): add device-detail lib (loadDevice/Neighbors/Circuits) (#39)"
```

### Task B2: NeighborsTable component

**Files:**
- Create: `apps/web/app/_components/neighbors-table.tsx`
- Create: `apps/web/test/neighbors-table.test.tsx`

**Step 1:** Write failing UI test using `renderToStaticMarkup` (per `apps/web/test/device-card.test.tsx` pattern; also remember CLAUDE.md pitfall about `vitest.workspace.ts` needing `.tsx` include + esbuild jsx:"automatic" — verify first).

```tsx
describe("NeighborsTable", () => {
  it("renders headers + rows with links to /device/[name]", () => {
    const rows = [{ name: "UPE-1", role: "UPE", level: 2, site: "JED", local_if: "g0/1", remote_if: "g1/1", status: true }];
    const html = renderToStaticMarkup(
      <NeighborsTable rows={rows} total={1} page={0} size={50} sortBy="role" deviceName="ICSG-1" />,
    );
    expect(html).toContain('href="/device/UPE-1"');
    expect(html).toContain("UPE");
    expect(html).toContain("g0/1");
  });

  it("shows pagination controls when total > size", () => { /* assert next-page link + aria-label */ });
  it("renders a sort toggle for role and level", () => { /* assert `?sort=level` link */ });
  it("shows empty state when rows.length === 0", () => { /* assert 'No neighbors' */ });
});
```

Run: `pnpm --filter web test -- --run neighbors-table`
Expected: FAIL, module not found.

**Step 2:** Implement the component. Server-rendered pagination via query params (`?page=0&sort=role`), not client state.

**Step 3:** Run tests, commit.

```bash
git commit -m "feat(web): add NeighborsTable component (#39)"
```

### Task B3: Rewrite `/device/[name]/page.tsx` as detail page

**Files:**
- Modify: `apps/web/app/device/[name]/page.tsx` (full rewrite)
- Create: `apps/web/test/device-detail-page.test.tsx` (UI smoke)

**Step 1:** Write failing tests:

```tsx
describe("DeviceDetail page (/device/[name])", () => {
  it("calls notFound() when loadDevice returns null", async () => { /* mock loadDevice → null, expect notFound thrown */ });
  it("renders header fields + neighbors + circuits + links to /path + /topology + /impact", async () => { /* spy loaders, render server component via Next.js testing helper or snapshot the children */ });
});
```

Run: fails.

**Step 2:** Implement. Use `next/navigation`'s `notFound()` for the unknown-device case.

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import {
  loadDevice, loadNeighbors, loadCircuits,
  type NeighborSort,
} from "@/lib/device-detail";
import { iconFor } from "@/lib/icons";
import { LevelBadge } from "@/components/LevelBadge";
import { NeighborsTable } from "@/app/_components/neighbors-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function DevicePage({
  params,
  searchParams,
}: {
  params: { name: string };
  searchParams: { page?: string; sort?: string };
}) {
  await requireRole("viewer");
  const name = decodeURIComponent(params.name);

  const device = await loadDevice(name);
  if (!device) notFound();

  const page = Math.max(0, parseInt(searchParams.page ?? "0", 10) || 0);
  const sortBy: NeighborSort =
    searchParams.sort === "level" ? "level" : "role";

  const [{ rows, total }, circuits] = await Promise.all([
    loadNeighbors(name, { page, size: PAGE_SIZE, sortBy }),
    loadCircuits(name),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Header device={device} />
      <Actions name={name} />
      <section data-testid="neighbors">
        <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Neighbors ({total})
        </h2>
        <NeighborsTable rows={rows} total={total} page={page} size={PAGE_SIZE} sortBy={sortBy} deviceName={name} />
      </section>
      <section data-testid="circuits">
        <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Inbound circuits ({circuits.length})
        </h2>
        <CircuitsTable rows={circuits} />
      </section>
    </main>
  );
}

function Header({ device }: { device: DeviceDetail }) { /* name, role icon, level badge, site, vendor */ }
function Actions({ name }: { name: string }) {
  const enc = encodeURIComponent(name);
  return (
    <nav className="mt-4 flex flex-wrap gap-2 text-xs">
      <Link href={`/path/${enc}`} data-testid="action-trace">Trace to core</Link>
      <Link href={`/device/${enc}/downstream`} data-testid="action-downstream">Downstream</Link>
      <Link href={`/topology?around=${enc}`} data-testid="action-topology">Topology</Link>
      <Link href={`/impact/${enc}`} data-testid="action-impact">Impact</Link>
    </nav>
  );
}
function CircuitsTable({ rows }: { rows: Circuit[] }) { /* mobily_cid, cid, role */ }
```

Run tests. Expect green.

**Step 3:** Commit.

```bash
git commit -m "feat(web): device detail page — header + neighbors + circuits (#39)"
```

### Task B4: 404 behavior — app/device/[name]/not-found.tsx

**Files:**
- Create: `apps/web/app/device/[name]/not-found.tsx`

**Step 1:** Write an E2E or UI test: visit an unknown name → expect HTTP 404 (Playwright `response.status()`).

Add to the new `apps/web/e2e/device-detail.spec.ts` (created in B5):

```ts
test("unknown device → 404", async ({ page }) => {
  const resp = await page.goto(`/device/${encodeURIComponent("NO-SUCH-DEVICE-XYZ")}`);
  expect(resp?.status()).toBe(404);
});
```

**Step 2:** Implement minimal `not-found.tsx` with device-shaped message.

### Task B5: E2E spec — detail page neighbor list assertion

**Files:**
- Create: `apps/web/e2e/device-detail.spec.ts`

**Step 1:** Seed ICSG + UPE + RAN like in the integration test but through the E2E Postgres+Neo4j seeding pattern used in `apps/web/e2e/path-trace.spec.ts` (same `withPg` + `neoDriver` helpers). Name them with `E2E-DETAIL-` prefix.

**Step 2:** Test flow:
1. Login as the seeded viewer.
2. Navigate to `/device/E2E-DETAIL-ICSG`.
3. Assert header contains "ICSG" role and level badge.
4. Assert `[data-testid="neighbors"]` contains `E2E-DETAIL-UPE` and both `E2E-DETAIL-RAN-1`, `E2E-DETAIL-RAN-2` as links (`href="/device/…"`).
5. Click `[data-testid="action-trace"]` → URL becomes `/path/E2E-DETAIL-ICSG`.
6. Click `[data-testid="action-downstream"]` → URL becomes `/device/E2E-DETAIL-ICSG/downstream`.

**Step 3:** Run locally against the CI compose overlay (`docker-compose.ci.yml`): `PLAYWRIGHT_BASE_URL=http://localhost pnpm --filter web test:e2e -- device-detail`.

Expected: PASS.

**Step 4:** Commit.

```bash
git commit -m "test(e2e): device detail page — seeded ICSG neighbor assertions (#39)"
```

---

## Phase C — Full-suite verification

### Task C1: Run the whole test pyramid

Run in order — each MUST be green before the next:

1. `pnpm -r typecheck` — whole workspace
2. `pnpm --filter web test -- --run` — unit tests
3. `pnpm --filter web test:int` — integration (Docker needed)
4. `docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait`
5. `pnpm --filter web test:e2e`
6. `pnpm -r lint`

For any failure: stop and debug via `superpowers:systematic-debugging`. Do NOT silently retry or skip.

### Task C2: Agent-pipeline review (required, 3+ files changed)

Invoke `agent-pipeline` on the diff. Address all architect + security + code-review + test findings before PR. Simplifier pass is last. This is mandatory per CLAUDE.md (3+ files).

### Task C3: Verification-before-completion

Invoke `superpowers:verification-before-completion`. Provide fresh evidence:
- Integration test output showing the 4 new test cases pass.
- E2E test output showing the seeded-ICSG neighbor assertion passes.
- Screenshot of the detail page rendered against the seeded compose (save under `.playwright-mcp/` — gitignored per memory).
- Confirmation `CLAUDE.md` has NO changes from this branch (the unrelated pre-existing modification must not have been accidentally staged).

### Task C4: PR

```bash
git push -u origin feat/issue-39-device-detail-page
gh pr create --title "feat: device detail page — header + neighbors + circuits (#39)" --body "<per issues-to-complete template>"
```

Wait for CI via `gh pr checks <N> --watch` (remember CLAUDE.md pitfall: **never** pass `--fail-after`).

---

## Pitfall checklist (from CLAUDE.md — verify before committing each change)

- [ ] `apps/web/vitest.workspace.ts` includes `.tsx` + has `esbuild: { jsx: "automatic" }` for the unit project — required for the new `*.test.tsx` files.
- [ ] `@tsm/db` rebuilt if any `packages/db/src/` export added (none planned; confirm).
- [ ] `csvEscape` + `sanitizeFilename` not needed here (no CSV export in S21).
- [ ] No `:Core` label filter — we query by `name` (unique index) and don't filter by role in neighbor query.
- [ ] No variable-length `*1..N` Cypher in this plan (we use single-hop).
- [ ] E2E seeds prefixed with `E2E-DETAIL-`.
- [ ] `downstream.ts` unchanged. Existing `/device/[name]/downstream` route unchanged.
- [ ] The pre-existing `M CLAUDE.md` does NOT get committed on this branch.

---

## Three-strike tripwire

If any of the following repeats 3× on the same task, stop and surface to human — do not attempt fix #4:

- A Cypher query returns unexpected ordering or row count
- Vitest workspace JSX resolution fails
- Playwright cannot seed the testcontainers Postgres/Neo4j
- CI fails on a check that passes locally

Specific fallback: if seeding ICSG with `:ICSG` label fails because the resolver dropped ICSG, label the seeded device `:Device:ICSG` explicitly in the seed, matching `apps/web/test/path.int.test.ts:35-39` (which does this).
