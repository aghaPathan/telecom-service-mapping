# Downstream / Blast-Radius (Issue #10) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** From a device, return (and visualize) every device reachable via CONNECTS_TO hops where each step strictly increases `level`. Answer "if device X goes down, who loses service?"

**Architecture:** New `GET /api/downstream` (JSON) + `GET /api/downstream/csv` (text/csv). Cypher does grouping + counts in one round-trip. New route `app/device/[name]/downstream/page.tsx` renders a left tree (by level/role) and a right list with domain+role filters. Reuses `RoleBadge`, `rate-limit`, zod-resolver pattern from #8/#9. `device_level` index already exists.

**Tech stack:** Same as #9 — Next.js 14 server components, Neo4j 5, zod, vitest + testcontainers, Playwright.

---

## Key design decisions

1. **Strict `<` predicate** — moving away from start, level must strictly increase. `nodes[i].level < nodes[i+1].level`. MW-MW equal-level pairs MUST NOT traverse.
2. **MW transparency is a post-filter, not a traversal filter.** Cypher must still match paths that pass THROUGH MW nodes so that RAN/Customer nodes beyond MW are discovered. Remove MW from the RESULT set unless `include_transport=true`. If MW is filtered in the MATCH itself, we lose everything behind it.
3. **Grouping in Cypher.** Emit `collect(dst)` grouped by `role, level` in the query, not in JS, to meet the <2s budget.
4. **Cap max_depth at 15 server-side** via zod `.max(15)`. Default 10. DoS guardrail.
5. **CSV-injection safe export.** Any cell value beginning with `= + - @` or containing `"`, `,`, newline, or tab must be double-quote-wrapped with embedded quotes doubled AND formula-prefix-escaped with a leading `'`.
6. **CSV filename sanitation.** `Content-Disposition` filename is derived from the device name but restricted to `[A-Za-z0-9._-]` — other chars collapse to `_`. No path traversal or header injection.
7. **Cycle safety.** Strict monotonic `<` makes traversal DAG-like by level — still add an explicit cycle-at-same-level test.
8. **Response shape** (zod):
   ```ts
   {
     status: "ok",
     start: DeviceRef,          // echo the start device (useful for UI header)
     total: number,
     groups: Array<{ level: number, role: string, count: number, devices: DeviceRef[] }>
   }
   | { status: "start_not_found" }
   ```

---

## Phase A: Resolver + schemas + integration tests

### Task A1: `apps/web/lib/downstream.ts` — schemas + `runDownstream`

- Zod `DownstreamQuery` = `{ device: string (1..200 chars), max_depth: number .min(1).max(15).default(10), include_transport: boolean.default(false) }`.
- Export `MAX_DOWNSTREAM_DEPTH = 15` constant with a WHY comment.
- Export `DownstreamResponse` discriminated union.
- `runDownstream(q)`:
  - Resolve start device; 404 → `start_not_found`.
  - Cypher: `MATCH p = (start:Device {name:$name})-[:CONNECTS_TO*1..$maxDepth]-(dst:Device)` with `WHERE ALL(i IN range(0, length(p)-1) WHERE nodes(p)[i].level < nodes(p)[i+1].level)` + `WITH DISTINCT dst` + `WHERE $include_transport OR dst.level <> 3.5` + `WITH dst.role AS role, dst.level AS level, collect(dst { .name, .role, .level, .site, .domain }) AS devices RETURN role, level, devices, size(devices) AS count ORDER BY level ASC, count DESC`.
  - Notes: `$maxDepth` cannot be parameterized inside the variable-length bound in Neo4j — interpolate the validated integer, same pattern as `MAX_PATH_HOPS` in `lib/path.ts`. Since zod enforces `.max(15)` and `.int()` before this point, interpolation is safe. Add WHY comment.
- Return `{ status:'ok', start, total, groups }`.

### Task A2: Unit tests `apps/web/test/downstream.test.ts`
- `parseDownstreamQuery` accepts `{device:"d"}`, fills defaults.
- Rejects missing device, empty device, over-200 device.
- Rejects `max_depth` < 1 or > 15.
- Accepts `include_transport: true|false`.
- CSV helper (next task) tests live in same file for cohesion.
- `DownstreamResponse` schema round-trips ok and start_not_found shapes.

### Task A3: CSV helper `apps/web/lib/csv.ts`
- `csvEscape(value: string | number | null): string` — per-cell escape.
  - Null → empty string.
  - If value starts with `=`, `+`, `-`, `@`, `\t`, `\r` → prefix with `'` AND wrap in quotes.
  - If contains `"`, `,`, `\n`, `\r`, `\t` → wrap in quotes; double any embedded `"`.
  - Otherwise → raw.
- `csvRow(values: (string|number|null)[]): string` — joins escaped cells with `,`.
- Unit tests for every branch.

### Task A4: Integration tests `apps/web/test/downstream.int.test.ts`
Seed fixture (21 devices):
```
Core1(1) — UPE1(2) — CSG1(3) — MW1(3.5) — RAN1(4) — Cust1..Cust5(5)
                              \— RAN2(4) — Cust6..Cust10(5)
                    \— MW2(3.5) — RAN3(4) — Cust11..Cust15(5)
          \— UPE2(2) — CSG2(3) — CSG3(3)    <-- cycle peer at same level (should not traverse)
                       \— CSG2  (cycle back)
Island(3) — no edges
```

Tests:
1. Downstream from `UPE1` default → groups contain CSG, RAN, Customer; does NOT contain MW by default; totals match.
2. Same query with `include_transport=true` → MW now present in groups.
3. Downstream from `CSG2` → does NOT include `CSG3` (same-level peer, strict `<` predicate).
4. Downstream from `Island` → `status:'ok', total:0, groups:[]`.
5. Downstream from unknown name → `status:'start_not_found'`.
6. `max_depth=1` from `UPE1` → only direct level-3 children (no grandchildren).
7. Cycle safety — no infinite loop, distinct devices only.

Commit per task.

---

## Phase B: Routes + UI + CSV

### Task B1: `GET /api/downstream`
File: `apps/web/app/api/downstream/route.ts`. Pattern = `api/path/route.ts`. Rate-limit key `downstream:<user>`. Parse query string against `DownstreamQuery`. Call `runDownstream`. 400/429/503/200.

### Task B2: `GET /api/downstream/csv`
File: `apps/web/app/api/downstream/csv/route.ts`. Same rate limiter (different key `downstream-csv:<user>`). Same zod schema (no `include_transport` default toggle visible in UI — for now CSV uses same default). Returns `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="downstream-<sanitized>.csv"`. Header row: `name,role,level,site,domain`. One row per device, sorted by level then name. Use `csvEscape` for every cell. On error → 503 with JSON (content type won't match but browsers handle fine).

### Task B3: UI page `apps/web/app/device/[name]/downstream/page.tsx`
Server component. `requireRole("viewer")`. Calls `runDownstream` directly. Renders:
- Header with start device name, role, level.
- Summary line with per-role counts (e.g. "3 CSG · 42 RAN · 1,204 customers").
- Left column: tree grouped by level then role (collapsible not required in MVP).
- Right column: full flat list with client-side filter inputs for role and domain. Filter is a client component since it's interactive.
- CSV export link: `<a href="/api/downstream/csv?device=...">Export CSV</a>`.
- Include-transport toggle: checkbox that flips `include_transport` query param via page navigation (server-round-trip is fine for MVP).

### Task B4: Link from device detail page
In `apps/web/app/device/[name]/page.tsx`, add a button `<Link href={"/device/" + encodeURIComponent(name) + "/downstream"}>View downstream</Link>` in the header area. Data-testid `downstream-link`.

### Task B5: Unit tests for UI filter client component
Only the filter logic — pure function `filterDevices(devices, { role, domain })` tested with varied inputs.

---

## Phase C: E2E + perf marker

### Task C1: E2E `apps/web/e2e/downstream.spec.ts`
Seed a Core→UPE→CSG→MW→RAN→2×Customers fixture. Tests:
1. Login as viewer → visit `/device/E2E-DOWN-UPE/downstream` → see "2 Customer" in summary; see both customer names in list; MW NOT rendered by default.
2. From omnibox search `E2E-DOWN-UPE` → click → on device page, click "View downstream" link → lands on downstream page.
3. Visit same with `?include_transport=true` → MW now visible.
4. CSV export — fetch `/api/downstream/csv?device=E2E-DOWN-UPE` via `request.get()`, assert 200 + `Content-Type: text/csv` + body contains customer names and NOT MW.

### Task C2: Perf marker
Add a one-line `TODO(#10-perf)` comment above the downstream Cypher in `runDownstream`: "profile against production graph; <2s p95 target per issue #10."

### Task C3: CLAUDE.md pitfall note
Append ONE bullet to the "Common pitfalls" section in the repo's `CLAUDE.md`:
```
- **Don't filter MW in the traversal WHERE — filter it in the projection.** Downstream queries must traverse THROUGH `:MW` (level 3.5) to reach the RAN/Customer devices behind it; exclusion happens post-collection unless `include_transport=true`.
```

---

## Acceptance criteria mapping
- `GET /api/downstream?device=&max_depth=` auth-required, default 10 → Task B1 + A1 zod default
- Strict-greater-level traversal, no loops → Task A1 Cypher + A4 tests
- Response grouped by level → A1 Cypher groups + A4 tests
- Aggregated counts per role → A1 emits `count` per group
- UI tree left, list+filter right → B3 + B5
- CSV export → A3 + B2 + C1
- Perf <2s → `device_level` index (already added) + C2 follow-up
- MW transparency + `include_transport` flag → A1 + A4 tests #1,#2
- Integration tests — grouping, depth bound, cycle safety → A4 tests #1, #6, #3+#7
- E2E — login → search → downstream → counts → C1
