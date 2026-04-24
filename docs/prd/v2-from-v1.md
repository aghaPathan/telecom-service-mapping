# PRD — Telecom Service Mapping V2, Informed by V1

**Status:** Draft v1 · **Date:** 2026-04-24 · **Owner:** Agha Awais · **Audience:** Engineering + Management

---

## Executive Summary (for management)

V1 (Django monolith at `/Users/aghaawais/Mobily/git/ServiceMapping_Portal`) is today's de-facto source of truth for the Mobily multi-domain, multi-vendor network service layer — from core through transport down to the customer edge. It works, but it carries hidden technical debt: graph topology runs on a pre-built NetworkX pickle file, performance dashboards silently zero out missing data, auth is bypassed on several routes, and critical features (e.g. `/devices?site=` analogues) ship without navigation entries.

V2 (this repository) replaces V1 with a configurable graph model in Neo4j, a deterministic ingest pipeline with explicit edge-case contracts, role-based access control, and a modern Next.js UI. Today V2 ships **15 routes covering path-trace, blast-radius, device detail, analytics, admin, and saved views**, all backed by testcontainer-based integration tests.

**This PRD proposes the scope to declare V2 "ready to replace V1 for graph-centric workflows"**:

- **Adopt (12 items)** — the V1 capabilities whose absence would block cutover: dashboard KPIs, isolation view, full device list with site filter, device-to-device path, node topology viewer, DWDM tables + topology, SNFN overlay, map+topology split panel, full navigation IA, XLSX export parity, v1-bug corrections, and weighted edge path-tracing.
- **Defer to v2.1 (4 items)** — the ClickHouse-backed surface: IP performance top-10, per-device 24h dashboards, RAN KPI gauges, BNG/OLT customer summaries. These require adding an analytical datastore; deferring keeps V2's cutover clean.
- **Reject (3 items)** — V1 patterns we will not carry forward: auth-middleware bypass paths, "Alarms = up-set" inverted-liveness semantics, and SSH-from-web-app (SAI Ping) as a production feature.

**Risk-weighted effort to V2 parity: roughly 8–10 engineering weeks** broken into 5 rollout slices, each with acceptance tests tied to a V1 page. Weighted-edge ingestion, DWDM modeling, and topology point-to-point are the three load-bearing technical decisions; all three have concrete recommendations below with rollback paths.

---

## Problem Statement

From the user's perspective:

> "We have V1 today. It works, but every time I answer a question like *'if this core router goes down, which customer circuits light up?'* I'm stringing together three pages and a CSV export, and the numbers on the dashboard don't always agree with the numbers on the drill-down. V2 is supposed to be the 'one-stop shop' — but right now several of the V1 pages I rely on don't exist in V2, and some V2 pages exist but I can't find them in the menu. I want V2 to replace V1 without losing anything operationally important, and I want it to be the thing I can show to leadership as the single source of truth."

Concretely:

1. **Feature gaps.** V1 has ~36 operator-facing surfaces; V2 ships 15. Several V1 features (isolation view, device-by-site list, DWDM, full dashboards) have no V2 equivalent.
2. **Data-consistency doubts.** V1's ClickHouse wrapper silently converts `NaN`/empty/`'NIL'` → `0`, masking missing data. Users have seen dashboard aggregates disagree with drill-down numbers and don't trust the numbers at night.
3. **Ingestion edge cases live in V1 Python code only.** 31 V1 preprocessing rules (`Topo.py`, `data_populate.py`, `lldp_view.py`, `olt_bng_details.py`, `dwdm_view.py`) are undocumented. Without explicit capture, V2 risks drifting from V1 behavior and producing "different figures".
4. **Navigation is incomplete in V2.** `/map`, `/impact`, `/topology`, `/summary`, `/admin/users`, `/ingestion` are not in the global nav. `/devices?site=` is linked from two places but the route does not exist (it 404s). Pages exist but are undiscoverable.
5. **Docker-compose dev↔prod drift.** User asked for compose parity. V1 has no compose; the question maps to V2's internal drift between `docker-compose.yml`, `docker-compose.local.yml`, `docker-compose.ci.yml` — ingestor has no healthcheck, `web` depends on `service_started` (not `healthy`), HSTS/CSP stubs are commented out.
6. **No comprehensive PRD exists** describing what V2 must do, what V1 behaviors to preserve, and what to drop. Engineering is shipping slices without a master spec.

## Solution

A single, comprehensive, V1-informed V2 specification that:

- Enumerates V1's 36 surfaces and classifies each as **adopt / defer / reject** with rationale.
- Captures the **31 ingest edge-case rules** from V1 as a first-class contract V2's ingestor must honor — so "different figures" becomes a contract violation we can test for, not a mystery.
- Resolves 6 open architectural decisions (ClickHouse, edge weights, multi-label roles, DWDM, point-to-point, compose) with a concrete recommendation and a rollback path per decision.
- Fixes navigation so every V2 route is either explicitly in the nav, explicitly deferred, or explicitly a dev-only page.
- Identifies 4 **V1 bugs** that V2 must *not* inherit (V1 `total_offline` returns online rows; ClickHouse wrapper silently zeros null data; `data_populate` has unreachable NSR branch and no CID dedup).
- Lays out a 5-slice rollout plan; each slice has an acceptance checklist tied to a V1 page, so we can walk stakeholders through "here is what V2 now does that V1 did."

The PRD targets both management (exec summary, §§1–3, §15) and engineering (§§6–14 for implementation). Section anchors in the table of contents make it scannable.

---

## User Stories

### Network operators (daily users — viewer + operator roles)

1. As a transport operator, I want a single landing page showing total devices by vendor and current isolation counts so that I can see the overall network health in one glance.
2. As a transport operator, I want to type a device name, a circuit CID, or a Mobily CID into one search box and be taken to the right detail page, so that I do not have to remember which page to start from.
3. As a transport operator, I want to see the active-links table filtered by site/role/vendor/domain, so that I can find the devices in a specific building or of a specific role without scrolling.
4. As a transport operator, I want to click a site on a map and see both the site's device list and its graph topology in the same view, so that I get both the "where" and the "how it connects" without navigating between pages.
5. As a transport operator, I want to trace the path from any customer-edge device all the way to the nearest core router, so that I can confirm which transport chain carries that customer.
6. As a transport operator, I want to trace a path between any two devices (device A → device B, not only device → core), so that I can validate mid-network routes for maintenance windows.
7. As a transport operator, I want to compute blast-radius for a device and see the impacted devices grouped by role and level, so that I can estimate customer impact before a change window.
8. As a transport operator, I want to include or exclude microwave (L3.5 transport) hops in both path and blast-radius queries with a single toggle, so that I can reason about fiber-only vs fiber+microwave reachability.
9. As a transport operator, I want to export the impact table as XLSX (not only CSV) with role summary counts, so that I can paste it directly into change-advisory-board decks.
10. As a transport operator, I want to save a frequently-used query (path, downstream, impact, or topology view) under a memorable name so that I can reopen it tomorrow without rebuilding the filters.
11. As a transport operator, I want saved queries to optionally be shared by role (e.g. "visible to operators"), so that a colleague on shift handover can reopen the same investigation.
12. As a transport operator, I want to see the isolation list — devices present in inventory but not currently reachable via LLDP — so that I can chase real outages first.
13. As a transport operator, I want to see which path the topology viewer considers "up to core" versus dashed non-core edges, so that I can see routing at a glance.
14. As a transport operator, I want a node-topology page that shows a device and its 1-hop neighbors with the option to expand to more hops, so that I can explore connectivity interactively.
15. As a transport operator, I want to see DWDM links as a separate overlay with Ring and SNFN CID affiliation, so that I can reason about the optical layer when a fiber event is suspected.
16. As a transport operator, I want to click an edge in a topology view and see the SNFN CIDs carried on it, so that I can open a ticket with the right CID.

### Core engineers (operator role, deeper need)

17. As a core engineer, I want the path-trace to honor ISIS edge cost (not just hop count), so that path computation matches what the routers actually do.
18. As a core engineer, I want to see edge weights in the path-trace ribbon, so that I can explain why a longer-hop path was chosen.
19. As a core engineer, I want to filter the device list by multiple roles simultaneously (e.g. "3G or 4G"), so that I can build multi-technology inventories without manual joining.
20. As a core engineer, I want the UPE-clustering toggle to be remembered in my saved view, so that my dashboard looks the same tomorrow.

### Senior leadership (management role — read-only, summary-oriented)

21. As the head of transport, I want an executive dashboard showing network size, vendor distribution, and the most recent ingest status, so that I can confirm the portal's data is fresh before citing numbers.
22. As the head of transport, I want a map of technical buildings with status and core-device counts, so that I can see geographic distribution in one view.
23. As the head of transport, I want to see "last successful ingest: 4h ago" prominently on every page, so that I always know whether I'm looking at today's or yesterday's data.

### Security / admin (admin role)

24. As an admin, I want to create new users via a CLI without exposing a self-signup form, so that access is provisioned deliberately.
25. As an admin, I want to set a user's role to viewer / operator / admin, so that I control what each person can see.
26. As an admin, I want to disable a user's access and revoke all active sessions in one action, so that offboarding is immediate.
27. As an admin, I want to see an audit log of admin actions (user created, role changed, session revoked), so that I can answer "who did what when" during a security review.
28. As an admin, I want to see ingestion-run history (started, duration, status, rows processed, warnings), so that I can diagnose upstream source issues.
29. As an admin, I want to manually trigger an ingestion run from the UI, so that I can force a refresh without SSH-ing to the host.
30. As an admin, I want a nav entry for Admin → Users / Audit / Saved-Views Admin, so that admin surfaces are discoverable.

### Data-quality stewards

31. As a data-quality steward, I want the ingestor to explicitly count and report (a) null device_b rows dropped, (b) self-loops dropped, (c) anomalies (same key, >2 rows) where it kept latest-wins, (d) unresolved role tokens, so that I can see data quality trending over time.
32. As a data-quality steward, I want the ingestor to NOT silently zero out NaN/empty/'NIL' values in any downstream metric, so that missing data is surfaced as missing in the UI.
33. As a data-quality steward, I want the ingestor's edge-case handling (31 documented rules) to have unit or integration tests, so that a regression shows up as a failing test, not a silent behavior change.
34. As a data-quality steward, I want the UI to render `null` as "—" or "No data", not as `0`, so that I can tell the difference between "zero devices" and "we don't know".
35. As a data-quality steward, I want an isolation neighbor-count to reflect reality (array length, not a semicolon-string hack), so that my scripts don't have to replicate the V1 trick.

### Developers (internal)

36. As a developer, I want the configurable hierarchy (`config/hierarchy.yaml`) and role-codes (`config/role_codes.yaml`) to be the single source of truth for node classification, so that renaming a role does not require hunting Cypher strings in four places.
37. As a developer, I want a test that fails when hierarchy.yaml is renamed in isolation (without updating the SW dynamic-leveling Cypher), so that the silent-no-op failure mode is caught.
38. As a developer, I want every `apps/web/app/api/*` route to have either a UI caller or an explicit "external contract" comment, so that dead APIs don't accumulate.
39. As a developer, I want the compose files (prod / local / CI) to have a single-source-of-truth matrix with healthchecks on every service (including ingestor), so that `depends_on: service_healthy` is usable everywhere.
40. As a developer, I want lint and typecheck wired on every workspace (including ingestor), so that CI catches issues at PR time.

### Reviewers / change-management

41. As a reviewer, I want saved views to be versioned (timestamp and last-updated), so that I can tell whether a colleague's saved view is still current.
42. As a reviewer, I want the PRD's gap matrix to be the acceptance checklist for cutover, so that "V2 is ready" is an objectively-measurable state.

### Cross-cutting / accessibility

43. As a user with color-vision issues, I want path-trace and topology views to not convey information by color alone, so that I can identify core-path edges without relying on blue.
44. As a keyboard user, I want the topology canvas and tables to be fully keyboard-operable (focus-visible, tab order, ESC to close modals), so that I don't need a mouse.
45. As a screen-reader user, I want all tables to have proper headers and ARIA labels, so that I can navigate the data.

### Data-sensitivity / compliance

46. As a security officer, I want the V2 app to never log hostnames, customer CIDs, IPs, or MACs, so that operator data doesn't leak into error tracking.
47. As a security officer, I want CSV/XLSX exports to have filename sanitization (no CRLF, no path traversal) and cell-escape (no formula injection), so that a malicious field can't compromise a downstream Excel user.
48. As a security officer, I want session cookies to be `Secure` + `__Secure-` prefixed on HTTPS deployments and dropped on HTTP-only LAN deployments, so that production browsers don't silently drop the cookie.
49. As a security officer, I want the `/admin/users` page and all admin APIs behind role-gate `admin`, confirmed by integration test, so that regressions in authz show up as failing tests.
50. As a security officer, I want no V1 auth-bypass pattern ported (V1 exempts `/performance`, `/tools`, `/event`, `/api` from the login middleware), so that V2's auth surface stays tight.

---

## Implementation Decisions

### Architectural decisions (with recommendations)

1. **ClickHouse fork — Deferred to v2.1.** V2 MVP ships graph + path + blast-radius + DWDM; ClickHouse-backed dashboards (top-10, per-device 24h, RAN KPI gauges, BNG/OLT customer summaries) are explicitly scoped to a named v2.1 milestone. **Rollback:** if v2.1 slips and dashboards become urgent, stand up ClickHouse as a read replica and port V1 queries 1:1, but *without* the V1 NaN→0 zeroing; render nulls as nulls.
2. **NetworkX → Cypher translation matrix.** Every V1 NetworkX algorithm maps to a V2 Cypher equivalent (see §"NetworkX → Cypher Translation"). Edge cases (UPE suppression, UPLINK_EXCLUDE_LIST, 8-digit numeric jumper, main-component threshold) become ingest- or query-time constraints, not a Python-resident pickle.
3. **Edge weights — Ingest `:CONNECTS_TO.weight` from ISIS cost.** V1's Dijkstra uses edge weights; V2 currently has none. Extend the ingestor to read ISIS cost (from `lldp_data.isis_cost` or equivalent source table) and attach as an edge property. Path Cypher becomes `shortestPath((a)-[:CONNECTS_TO*..15]-(b))` weighted via APOC `apoc.algo.dijkstra` *or* native `CALL gds.shortestPath.dijkstra.stream`. **Rollback:** if ISIS cost is not available at ingest time for MVP, ship hop-count path-tracing with a prominent "unweighted path" banner and a v2.1 ticket to add weight.
4. **Multi-label role classification — accept exclusive labels; add a tag array for reporting.** V2 keeps one primary role label per device (driven by `hierarchy.yaml`) and adds a `tags: string[]` property for cross-cutting classification (e.g. a `RGUF` device gets primary `:RAN4G` *and* tags `["3G","4G"]`). Reporting views filter on `tags` when a multi-technology bucket is requested. **Rollback:** if tag maintenance proves noisy, drop tags and ship a reporting-time re-bucketing view.
5. **DWDM data model — separate relationship type.** Model DWDM links as `[:DWDM_LINK]` between `:Device` nodes (distinct from `:CONNECTS_TO`), with properties `ring`, `snfn_cids`, `mobily_cids`, `span_name`, `protection_cid`. Keep raw `dwdm` table in Postgres for tabular views and CSV export; graph views read from Neo4j. **Rollback:** if the ingest cost of mirroring DWDM into Neo4j exceeds benefit, keep DWDM strictly in Postgres and render graph views by materializing on-demand.
6. **Topology point-to-point — implement `to` parameter.** The `/topology?from=A&to=B` mode currently ignores `to` and always traces to nearest core. Implement device-to-device path rendering using the same Cypher as the path-trace page (weighted if available, monotonic-level predicate relaxed when A and B are at the same level).
7. **Docker-compose remediation (not "parity" with V1, which has no compose).** Add healthcheck to ingestor service; tighten `web` `depends_on` to `service_healthy`; wire HSTS/CSP headers in `caddy/Caddyfile.acme`; document per-compose-file drift in a single `docs/decisions/0002-compose-model.md` ADR.

### Modules to be built or modified

**Ingestor pipeline (backend domain)**
- Extend LLDP dedup to emit per-rule drop counters (null_b, self_loop, anomaly) into `ingestion_runs.warnings` as structured JSON, not free-text strings.
- Add `ISIS-cost source` stage: read cost from source, emit `weight` per canonical pair, persist on the Neo4j edge.
- Add `tags` computation in the resolver (multi-label per hierarchy.yaml `tag_map` block, new config surface).
- Add isolation-view stage: emit rows for devices present in source inventory but absent from the dedup output (the V1 `Isolations` model analogue).
- Add alarms-ingestion stage (new, optional) — *deferred to v2.1* alongside ClickHouse.
- DWDM ingestion stage: read `public.dwdm` table from source, emit `:DWDM_LINK` edges with properties.
- SW dynamic-leveling: replace hardcoded `:CORE`/`:RAN`/`:Customer` label literals with a level-based lookup driven by `hierarchy.yaml`, plus an integration test that fails if the rename test case is violated.
- NaN-handling policy: no silent zeroing. Nulls propagate to the graph as null properties; UI layer is responsible for rendering.

**Web app query layer**
- `lib/path.ts` — accept device-to-device input (not only device-to-core); plug in weighted Cypher when edge weight is available; keep unweighted fallback behind a runtime feature flag.
- `lib/downstream.ts` — already handles MW correctly; add `tags[]` filter to WHERE.
- `lib/impact.ts` — add XLSX export alongside CSV; add role-summary aggregation pre-computed in the Cypher.
- `lib/dwdm.ts` (new) — tabular + graph queries for DWDM links and rings.
- `lib/isolations.ts` (new) — read from a new Postgres/Neo4j view of inventory-minus-graph.
- `lib/search.ts` — extend cascade to hit DWDM span names and SNFN CIDs.

**Web app UI**
- `app/_components/nav.tsx` (new) — two-row nav: Home, Devices, Core, Topology, Impact, Map, Analytics, Ingestion (+badge); admin row: Users, Saved Views, Audit.
- `app/devices/page.tsx` (new) — canonical device list with site/role/vendor/domain filters; fixes the `/devices?site=` 404.
- `app/isolations/page.tsx` (new) — isolation table with neighbor count and action links.
- `app/map/page.tsx` — merge with `/topology` into a split-panel: left = map, right = topology of the selected site.
- `app/dwdm/page.tsx` + `app/dwdm/[node]/page.tsx` + `app/dwdm/ring/[ring]/page.tsx` (new) — DWDM tabular and topology views.
- `app/topology/page.tsx` — implement `to` param (device-to-device); edge-click opens SNFN overlay.
- `app/impact/[deviceId]/page.tsx` — add XLSX export button; add role-summary row group at top.
- `app/admin/*` — add Saved Views admin panel and Audit Log page under the admin row.

**API surface cleanup**
- Remove or wire the 5 orphan APIs: `GET /api/path`, `GET /api/downstream`, `GET /api/views/[id]`, `PATCH /api/views/[id]`, `DELETE /api/views/[id]` — either add a UI caller or document as external contract with an integration test asserting shape.
- Implement `POST /api/ingestion/run` behind admin auth + audit log; add UI button on `/admin/ingestion`.

**Config surface**
- `config/hierarchy.yaml` — add optional `tag_map` block for multi-label tags.
- `config/role_codes.yaml` — stays single-source for role resolution.
- `config/sites.yaml` — expand to cover all technical buildings so `/map` stops showing "No sites have geographic coordinates yet".
- `config/dwdm.yaml` (new) — Ring naming rules and protection-CID handling.

**Compose + infra**
- `docker-compose.yml` — add healthcheck to `ingestor` service (e.g. `node dist/healthcheck.js` that exits 0 if last run's status is `success`/`running`, non-zero on `failed`).
- Tighten `web.depends_on.ingestor` to `condition: service_healthy`.
- `caddy/Caddyfile.acme` — wire HSTS + CSP (removing the "slice #11" TODO stubs).
- `apps/ingestor/package.json` — replace placeholder lint with real ESLint.

### V2 Ingest Edge-Case Contract (the 31 V1 rules, tagged)

**Port (V2 must replicate):**
- LLDP 8-column unique-key handling with null safety.
- Span name ` -  LD` / ` - NSR` suffix stripping (correctly implementing both branches, unlike V1's dead `elif`).
- Protection CID string `'nan'` → null.
- `status=false` LLDP rows excluded from active topology.
- 8-digit numeric node special-casing for path computation (business customer / jumper).
- `UPLINK_EXCLUDE_LIST` enforcement (RIPR / RGUX / RGUL / RGUF / RUFX / 2G / 3G / 4G / 5G) on alternate paths.
- Main-graph = largest weakly-connected component threshold (configurable; V1 uses >100k nodes).
- UPE neighbor suppression in topology rendering.
- Bidirectional edge dedup via canonical pair (V2 already has this; contract-test it).
- `wiconnect` → `wic` vendor alias, driven by a config map.
- `protection_cid` space-split → first CID resolution for DWDM protection paths.
- `connected_nodes` isolation neighbor count (expose as array length, not semicolon hack).
- RAN service code dictionary (V1 `Topo.py:43-67`, 22 codes).
- Fallback from `topology_devices_view` → `topology_devices_dynamic_view` (implement as a `COALESCE`-like read at ingest).
- Single edge per A→B hop (simple DiGraph; V1 inconsistently iterates `.values()` for multi-edges in one function and not another — V2 standardizes on simple-edge).
- BNG Master/Slave failover *(only relevant if SAI Ping is reconsidered; currently rejected)*.

**Fix (V1 bug → V2 correction):**
- V1 `download_olt` `total_offline` filter uses `status='Online'` (`olt_bng_details.py:504-506`) — V2 offline export MUST use `status='Offline'`.
- V1 `data_populate.py:36-40` NSR-suffix `elif` branch is unreachable — V2 implements both LD and NSR stripping.
- V1 `data_populate.py:57-68` uses `CID.objects.create()` with no dedup — V2 uses upsert / MERGE semantics on CID.
- V1 `click_house.py:37-41` silently zeros `NaN`, empty, and `'NIL'` in ClickHouse responses — V2 MUST NOT zero nulls. Render missing as missing.

**Reject (do not port):**
- V1 `LoginMiddleware` auth bypass for `/performance`, `/tools`, `/event`, `/api` — V2 keeps middleware strict.
- V1 `views.py:133` "alarms = node-is-up" inverted-liveness semantics — V2 treats alarms as alarms.
- V1 SSH-over-jump-server SAI Ping (`olt_bng_details.py:121-148`) as an in-web-app feature — V2 rejects SSH from web worker; redesign as an operator CLI tool outside the scope of V2.

### NetworkX → Cypher Translation

| V1 algorithm | V2 Cypher equivalent | Preserved edge cases |
|---|---|---|
| `nx.shortest_path(G, src, tgt, weight='weight')` | `shortestPath((s)-[:CONNECTS_TO*..15]-(t))` + weight via APOC or GDS | ISIS cost weight property must exist; else hop-count fallback with UI banner |
| `nx.shortest_path_length(...)` | Same, return `reduce(w=0, r IN relationships(p) | w + r.weight)` | Same |
| Custom Dijkstra excluding `UPLINK_EXCLUDE_LIST` | Same `shortestPath` with `WHERE NONE(n IN nodes(p) WHERE n.role IN $excluded_roles)` | Excluded roles live in `hierarchy.yaml`, not hardcoded |
| `nx.ego_graph(G, node, radius=1)` | `MATCH (d:Device {name:$n})-[:CONNECTS_TO*1..$r]-(nbr)` | Radius validated client-side (Zod), interpolated, max 4 |
| Custom weakly-connected components | `CALL gds.wcc.stream(...)` | Component threshold (V1: >100k) becomes config value |
| Blast-radius via component-removal | Current V2 `runImpact()` via BFS with level-monotonic predicate | MW included in traversal, excluded in projection — already correct |
| 8-digit numeric node special-handling | Ingest-time edge normalization: if node matches `^\d{8,}$`, add bidirectional `:CONNECTS_TO` edges | Flag in ingestor, not query layer |
| Multi-label regex classification | `tags[]` property set during resolver | Overlapping buckets re-queried via `WHERE 'X' IN d.tags` |

### Navigation / Information Architecture

**Row 1 (primary, always-visible, viewer+):** Home · Devices · Core · Topology · Impact · Map · Analytics · Isolations · DWDM · Ingestion (freshness badge)

**Row 2 (role-gated, admin only):** Admin → Users · Saved Views · Audit Log

**Removed from orphan-state:** `/map`, `/topology`, `/impact`, `/ingestion`, `/admin/users`, `/summary/[role]` all get entry points.

**Fixed 404:** `/devices?site=...` now exists as `/devices` with filter query params.

**Dev-only:** `/design-preview`, `/graph-preview` gated behind `NODE_ENV !== 'production'` via middleware.

### API contracts (additions)

- `GET /api/devices` — list with filter query params (`site`, `role`, `vendor`, `domain`, `tags[]`), pagination, sort.
- `GET /api/devices/csv` — CSV export with 100k hard cap.
- `GET /api/devices/xlsx` — XLSX export (same params, same cap).
- `GET /api/isolations` — isolation list.
- `GET /api/dwdm` — tabular DWDM; `GET /api/dwdm/graph?ring=X` for ring topology.
- `GET /api/snfn?a=&b=` — SNFN CIDs on the A-B edge.
- `POST /api/ingestion/run` — wire the existing stub to an actual trigger (admin-only, audit-logged).
- `GET /api/impact/xlsx` — XLSX export alongside existing CSV.

### Schema changes (Neo4j + Postgres)

Neo4j:
- `:CONNECTS_TO { weight: float (optional), a_if, b_if, status, updated_at }` — add `weight`.
- `:Device { tags: [string] }` — add tags array.
- `:DWDM_LINK { ring, snfn_cids, mobily_cids, span_name, protection_cid }` — new relationship type.
- New index: `CREATE INDEX device_tags FOR (d:Device) ON (d.tags)`.

Postgres:
- `ingestion_runs.warnings jsonb` — structured warning counters (null_b, self_loop, anomaly, unresolved_role_tokens).
- `saved_views.kind` — extend enum with `impact`, `topology`.
- `audit_log` — already exists; confirm new admin actions emit rows.

---

## Testing Decisions

**What makes a good test here:**
- Tests assert behavior observable at the query boundary (API response, Cypher result, exported CSV contents), not internal function signatures.
- Integration tests use **real Postgres and Neo4j via testcontainers** — no mocking of the graph. This is explicit per the project's feedback-memory rule and pays off when migrations or Cypher evolve.
- Edge-case tests drive ingestion: each of the 31 Port/Fix rules gets a test that feeds a fixture row triggering the edge case and asserts the expected output.
- UI is tested via (a) component unit tests for pure components, (b) integration tests for server-component data-fetching paths, (c) Playwright E2E for golden paths (login, search, path-trace, blast-radius, impact-XLSX, DWDM ring view).

**Modules to be tested:**

| Module | Test type | Prior art |
|---|---|---|
| `apps/ingestor/src/dedup.ts` (extended) | Unit + integration | `apps/ingestor/test/dedup.test.ts` |
| `apps/ingestor/src/resolver.ts` (tags) | Unit + integration | `apps/ingestor/test/resolver.test.ts` |
| `apps/ingestor/src/graph/writer.ts` (weight, tags, DWDM edges, hierarchy-rename guard) | Integration | `apps/ingestor/test/ingest.int.test.ts` |
| `apps/web/lib/path.ts` (device-to-device, weighted) | Unit + integration | `apps/web/test/path.int.test.ts` |
| `apps/web/lib/dwdm.ts` (new) | Unit + integration | Mirror `apps/web/test/search.int.test.ts` pattern |
| `apps/web/lib/isolations.ts` (new) | Integration | Mirror `apps/web/test/downstream.int.test.ts` pattern |
| `apps/web/lib/impact.ts` (XLSX export) | Unit for escape/filename, integration for cap | `apps/web/test/csv.test.ts`, `impact-csv.int.test.ts` |
| `apps/web/app/devices/*` | Component + E2E | Mirror `apps/web/test/device-list.test.ts` |
| `apps/web/app/_components/nav.tsx` | Component | Mirror existing header tests |
| Middleware (admin role gate) | Integration | Mirror `apps/web/test/rbac.test.ts` + `auth-flow.int.test.ts` |
| `config/*.yaml` contract (schema validation) | Unit | Zod schema tests, mirror resolver test |
| V1 bug-fix regressions (total_offline, CID upsert) | Integration | Mirror existing ingest.int.test.ts |

**Specifically asking for coverage of:**
- All 31 ingest edge-case rules — each rule = one test (fixture row that triggers it + assertion on dedup/resolver/Neo4j result).
- Hierarchy-rename guard (rename a role in hierarchy.yaml → SW dynamic-leveling Cypher fails loudly, not silently).
- Compose healthcheck matrix — integration test that `docker compose -f docker-compose.yml up --wait` fails if any service lacks a healthcheck.
- Null-rendering UI contract — snapshot test that `null` values render as "—", not "0".
- Admin-role integration test — every admin-only route 403s for non-admin, 200s for admin.

---

## Out of Scope

- **ClickHouse integration.** IP performance top-10, per-device 24h dashboards, RAN KPI gauges, BNG/OLT customer summaries are all deferred to v2.1. The Grafana iframe (`BNGPerformance`) may be ported as a link if the external Grafana instance is still live; otherwise dropped.
- **SAI Ping tool.** SSH-from-web-app is rejected as a V2 feature. If operationally critical, it is re-scoped as a separate CLI.
- **Alarms ingestion and active-alarms table.** Deferred to v2.1 alongside ClickHouse-or-equivalent alarm source integration.
- **Tools / Screens / Event portals.** These V1 pages are link-aggregator marketing pages; V2 replaces them with a single `/admin/links` admin-curated resource (itself deferred; no MVP blocker).
- **Domain-switcher.** V1's `/switchdomain` is rejected; V2 RBAC replaces the intent.
- **Interactive browser-side graph computation** (V1 vis-network with NetworkX-inspired frontend algorithms). V2 uses ReactFlow for rendering; all graph computation happens server-side in Cypher.
- **Real-time telemetry / streaming updates.** V2 stays nightly-refresh; real-time is out of scope for MVP.
- **Mobile-responsive UI.** V2 targets desktop; a mobile breakpoint pass is a v2.2 consideration.
- **Internationalization (i18n).** English only for MVP.

---

## Further Notes

### Rollout plan (5 slices)

1. **Slice A — Ingest contract + edge weights.** Land the 31-rule contract + tests; add edge weight + tags; ship DWDM ingestion. No UI change. Target: 2 weeks.
2. **Slice B — Navigation + `/devices` + `/isolations`.** Fix the 404; introduce `/isolations`; add the two-row nav; dev-page gating. Target: 1 week.
3. **Slice C — DWDM UI + SNFN edge overlay + map/topology split-panel.** The V1-feature-parity visible surface. Target: 2 weeks.
4. **Slice D — Topology device-to-device + path-trace weighted-edge UI + impact XLSX + saved-views for impact/topology.** Target: 2 weeks.
5. **Slice E — Admin hardening.** Wire `POST /api/ingestion/run`, add audit-log UI, HSTS/CSP in Caddy ACME mode, ingestor healthcheck, compose `service_healthy` tightening. Target: 1 week.

Each slice lands as a feature branch → PR with the acceptance tests from this PRD's test section.

### V1 reference — explicit do-not-read list

In line with `CLAUDE.md` data-sensitivity rules: do **not** copy real device names, customer CIDs, IPs, or MACs from V1's live DB into V2 fixtures, test seeds, or this PRD's examples. Use preserved-shape placeholders (`PK-KHI-CORE-01` → `XX-YYY-CORE-01`) when illustrating V1 behavior.

### Decisions journal

Each of the 6 architectural decisions (ClickHouse defer, edge weights, multi-label tags, DWDM model, point-to-point topology, compose remediation) gets an ADR under `docs/decisions/` before or concurrent with its implementing PR. ADR 0001 (auth stack) is the template.

### Audit provenance

The V1 analysis behind this PRD was produced by three parallel `Explore` subagents on 2026-04-24, covering (1) UI/IA, (2) ingestion + NetworkX, (3) V2 current-state. The full agent reports live in session memory; critical file:line citations are preserved in §"V2 Ingest Edge-Case Contract". The consulting advisor was invoked once to stress-test the gap matrix before this PRD was drafted.

### Explicit acknowledgement of user asks

The user's original request specified: multi-agent scan, edge-case agent, orphan-page agent, advisor consultation, docker-compose parity, NetworkX→V2 equivalent, ingestion-consistency check, PRD deliverable. All asks are reflected in this document — the "edge-case agent" and "orphan-page agent" are folded into the parallel-scan agents 2 and 3 rather than run as separate agents (folded for efficiency, not skipped).
