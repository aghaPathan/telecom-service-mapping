# Design — Issue #61 V2 Slice 4: DWDM + SNFN + Impact XLSX + Saved Views extension

> Status: design (pre-plan). Authority: this doc + issue #61 + PRD (`docs/prd/v2-from-v1.md` §"Modules to be built or modified" + §"Implementation Decisions"). Once approved, the implementation plan follows in `docs/plans/issue-61-v2-slice-4-plan.md`.

## Goal

Ship the four V1 surfaces still missing from V2 in one cohesive slice:

1. **DWDM**: ingest `public.dwdm`, model as `:DWDM_LINK` edges, render `/dwdm` list + `/dwdm/[node]` + `/dwdm/ring/[ring]`.
2. **SNFN edge overlay**: edge-click on any topology canvas opens a panel showing SNFN CIDs.
3. **Impact XLSX**: add XLSX export alongside existing CSV on `/impact/[deviceId]`, plus role-summary header.
4. **Saved Views extension**: add `impact` and `topology` to `saved_views.kind` enum, wire Save View button on those pages.

Plus the five contract rules deferred from #59 (rules #19, #20, #21, #27, #28) that need a CID parser, which DWDM ingestion naturally introduces.

## Boundary decisions

| Decision | Choice | Rationale |
|---|---|---|
| DWDM ingest cadence | Same nightly cron run as LLDP, new stage between `dedup` and `writer` | Same staleness window; one transactional run per night; no new scheduler |
| DWDM edge writer | Separate `[:DWDM_LINK]` relationship type, distinct from `:CONNECTS_TO` | PRD §142 — preserves blast-radius/path-trace semantics |
| `protection_cid='nan'` | Coerced to `null` (rule #20) | Matches V1 semantics exactly; null-as-null contract |
| `protection_cid` space-split | First non-empty token wins (rule #21) | V1 behavior; documented in PRD §205 |
| `span_name` LD/NSR suffix | Strip `' -  LD'` / `' - NSR'` suffixes both branches (rules #19, #27) | V1 had unreachable `elif`; V2 fixes |
| CID upsert | `MERGE (c:CID {cid:...})` semantics (rule #28) | V1 `objects.create()` allowed dupes; we MERGE |
| SNFN overlay on `:CONNECTS_TO` | Look up co-located `:DWDM_LINK` between same node pair; surface its CIDs, else empty state | Issue requires "any topology canvas"; LLDP edges have no SNFN data of their own |
| XLSX library | `exceljs` (already in tree if available; otherwise add) | Streaming write, formula-injection-safe via shared `csvEscape` adapter |
| Saved Views enum | `ALTER TYPE saved_view_kind ADD VALUE 'impact'; ADD VALUE 'topology'` (additive migration) | Postgres ENUM forward-only add, no data backfill needed |
| `public.dwdm` schema | **Inferred from PRD target properties** (see below); documented in `.claude/references/source-schema.md`; real-source validation flagged as PR follow-up | Schema not yet documented; testcontainer fixture drives canonical column shape |

## V1 ground truth — `public.dwdm` authoritative schema

Sourced from V1 codebase (`~/Mobily/git/ServiceMapping_Portal/app/views_/dwdm_view.py:54-60`, `dwdm_topology.py`, `helper_models/Topo.py:888-969`, `management/commands/data_populate.py`, `models/cids.py`, `models/span.py`).

### `public.dwdm`
| Column | Type | Notes |
|---|---|---|
| `device_a_name` | text | hostname |
| `device_a_interface` | text | port |
| `device_a_ip` | text | IP |
| `device_b_name` | text | hostname |
| `device_b_interface` | text | port |
| `device_b_ip` | text | IP |
| `"Ring"` | text | **CamelCase + double-quoted in V1 SELECT** — must keep quoted in our query |
| `snfn_cids` | text | space- or comma-separated CID list |
| `mobily_cids` | text | space-separated CID list |
| `span_name` | text | may carry `' -  LD'` or `' - NSR'` suffix |

No `status`, no `updated_at`, no `protection_cid` on this table — V1 reads all rows unconditionally and looks up `protection_cid` from the CID model at display time.

### `app_cid` (V1 `CID` model — already documented in `.claude/references/source-schema.md`)
- `cid`, `capacity`, `source`, `dest`, `bandwidth`, `protection_type`, `protection_cid`, `mobily_cid`, `region`
- `protection_cid` may be `'nan'` (V1 string sentinel for null) or space-separated list of alternate CID names

### V1 protection-path resolution (Topo.py:914-920)
```python
cid_obj = CID.objects.get(cid=main_cid)
protection_cids = cid_obj.protection_cid
if protection_cids != 'nan' and protection_cids != '':
    proc_cids = protection_cids.split(" ")
    # uses proc_cids[0] as the protection CID name
```

### V1 span-name suffix strip (data_populate.py:36-42 — applied during Excel→Span ingest)
```python
for span in span_names.split(","):
    span_value = span
    if len(span.split(" -  LD")) > 0:        # rule #19
        span_value = span.split(' -  LD')[0].strip()
    elif len(span.split(" - NSR")) > 0:      # rule #27 — V1 elif was unreachable; V2 must hit both branches
        span_value = span.split(' - NSR')[0].strip()
```

## Target Neo4j model (V1-faithful)

```
(:Device {name})-[:DWDM_LINK {
   ring,                  // string|null  (from "Ring" column)
   snfn_cids,             // string[]    (parsed list)
   mobily_cids,           // string[]    (parsed list)
   span_name              // string|null (LD/NSR suffix-stripped — rules #19, #27)
}]->(:Device {name})

(:CID {
   cid,                   // primary key (MERGE — rule #28)
   capacity,
   source,
   dest,
   bandwidth,
   protection_type,
   protection_cids,       // string[]    (parsed: 'nan' → empty, space-split — rules #20, #21)
   mobily_cid,
   region
})
```

**`protection_cid` lives on `:CID`, not `:DWDM_LINK`** — corrects PRD §142 imprecision per V1 ground truth (Topo.py:914-920). PR 2 (SNFN overlay) will look up `:CID` nodes for each `snfn_cids[i]` on a clicked edge to surface protection paths.

`[:DWDM_LINK]` direction is canonical (lesser→greater) like `:CONNECTS_TO`; treated as undirected when matching.

**Constraints / indexes:**
- `CREATE CONSTRAINT cid_uniq IF NOT EXISTS FOR (c:CID) REQUIRE c.cid IS UNIQUE;`
- `:DWDM_LINK` uniqueness handled by canonical-pair dedup pre-write (mirror existing LLDP pattern).

## File-level architecture

**Ingestor (`apps/ingestor/`)**
- `src/source/dwdm.ts` — new, mirrors `source/lldp.ts` shape; reads `public.dwdm` (note: keep `"Ring"` quoted in SQL); emits `RawDwdmRow[]`.
- `src/source/cid.ts` — new, reads `app_cid` and emits `RawCidRow[]`.
- `src/dedup.ts` — extend with `dedupDwdmRows()` using canonical interface-pair key.
- `src/cid-parser.ts` — new, pure parsers: `parseCidList(s)` (space/comma split, drop blanks), `parseProtectionCids(s)` (`'nan'`/empty → `[]`, else space-split — rules #20, #21), `stripSpanSuffix(s)` (LD then NSR, both branches — rules #19, #27).
- `src/graph/writer.ts` — extend writer to `MERGE` `:DWDM_LINK` edges + `:CID` nodes (rule #28: `MERGE (c:CID {cid:$cid}) ON CREATE/ON MATCH SET ...`). Wraps existing nightly transaction.
- `test/cid-parser.unit.test.ts` — pure parser tests for rules #19, #20, #21, #27.
- `test/dwdm.unit.test.ts` — dedup canonical-pair, both-direction merge.
- `test/dwdm-cid.int.test.ts` — testcontainer Postgres + Neo4j; 50-row DWDM + CID fixtures; rules #28 (CID upsert idempotency), edge directionality.
- `test/fixtures/dwdm-50.ts` — 50-row synthetic DWDM seed mapped onto existing `lldp-50` device set.
- `test/fixtures/cid-50.ts` — 50-row synthetic CID rows referenced by DWDM `snfn_cids`.

**Web — DWDM (`apps/web/`)**
- `lib/dwdm.ts` — Cypher queries: `listDwdmLinks(filter)`, `getNodeDwdm(node)`, `getRingDwdm(ring)`, `getSnfnForEdge(a, b)`.
- `app/api/dwdm/route.ts` — `GET /api/dwdm` tabular + CSV.
- `app/api/dwdm/graph/route.ts` — `GET /api/dwdm/graph?ring=X|node=X`.
- `app/api/snfn/route.ts` — `GET /api/snfn?a=&b=` (looks up `:DWDM_LINK` co-located with the queried edge).
- `app/dwdm/page.tsx` — list page with filter (device_a, device_b, ring, span_name) + CSV button.
- `app/dwdm/[node]/page.tsx` — per-node DWDM topology, dynamic SSR.
- `app/dwdm/ring/[ring]/page.tsx` — ring topology, dynamic SSR.
- `app/dwdm/_components/SnfnOverlay.tsx` — shared overlay component (used by /dwdm, /dwdm/[node], /dwdm/ring/[ring], /topology).
- `app/topology/topology-canvas.tsx` — wire edge-click → `SnfnOverlay`.
- `app/_components/MainNav.tsx` — add "DWDM" link to row 1 nav per PRD §238.

**Web — Impact XLSX (`apps/web/`)**
- `lib/xlsx.ts` — new, thin wrapper over `exceljs`. Reuses `csvEscape` for cell content; `sanitizeFilename` for `Content-Disposition`.
- `lib/impact.ts` — extend with `roleSummaryCounts(rows)` for the header row group.
- `app/api/impact/[deviceId]/xlsx/route.ts` — new XLSX export endpoint.
- `app/impact/[deviceId]/page.tsx` — add "Export XLSX" button + role-summary count rows above the existing table.

**Web — Saved Views extension (`apps/web/` + `packages/db/`)**
- `packages/db/migrations/1700000000050_saved-views-kind-extend.sql` — `ALTER TYPE saved_view_kind ADD VALUE IF NOT EXISTS 'impact'; ADD VALUE IF NOT EXISTS 'topology';`.
- `lib/saved-views.ts` — extend Zod kind enum.
- `app/impact/[deviceId]/page.tsx` — add Save View button (re-uses existing Save View component).
- `app/topology/page.tsx` — add Save View button.
- `app/_components/MyViewsDropdown.tsx` (or wherever the dropdown lives) — render impact/topology icons.

**Reference docs**
- `.claude/references/source-schema.md` — append `public.dwdm` columns.
- `apps/ingestor/test/contract/README.md` — flip rows #19/20/21/27/28 from `deferred` to landed; link to test names.
- `docs/decisions/0005-dwdm-data-model.md` — short ADR codifying the `:DWDM_LINK` choice + CID upsert.

## Data flow per feature

**DWDM ingest**
1. cron tick → `tickCron()` reads source LLDP (existing) + DWDM (new) in same run.
2. Dedup canonical pair per stage.
3. Resolver applies role labels (existing).
4. Writer commits `:Device` + `:CONNECTS_TO` (existing) + `:DWDM_LINK` + `:CID` (new) inside same Neo4j transaction.
5. `ingestion_runs` row records DWDM row counts in `warnings_json`.

**SNFN overlay**
1. User clicks edge on `/topology` or any `/dwdm/*` page.
2. Canvas fires callback with edge endpoints.
3. `<SnfnOverlay>` opens drawer, hits `GET /api/snfn?a=&b=`.
4. API queries Neo4j: `MATCH (a)-[d:DWDM_LINK]-(b) WHERE a.name=$a AND b.name=$b RETURN d.snfn_cids`. Returns CID list or empty array.
5. Drawer renders list or "No SNFN data for this edge".

**Impact XLSX**
1. User clicks "Export XLSX" on `/impact/[deviceId]`.
2. Browser hits `/api/impact/[deviceId]/xlsx`.
3. Handler reuses existing `getImpactRows()`, computes `roleSummaryCounts`, writes both into `lib/xlsx.ts` workbook (header rows = role summary, body rows = full impact).
4. Streams response with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` + sanitized filename.

**Saved Views extension**
1. Migration extends enum.
2. Zod adds `impact`/`topology` literals.
3. Save View button on `/impact/[deviceId]` and `/topology` writes a row with `kind='impact'`/`'topology'` and a `payload_json` shaped per page (impact: `{deviceId}`; topology: existing topology view payload).
4. My Views dropdown filters by enum and routes to `/impact/[id]?view=...` / `/topology?view=...`.

## Error handling

- ClickHouse / Postgres unreachable mid-ingest → mark `ingestion_runs.status='failed'`, do NOT null existing `:DWDM_LINK` weights/properties. Existing graph survives a failed pull.
- DWDM source row with NULL `device_b_name` → drop, count in `warnings_json` (mirrors LLDP rule).
- DWDM source row with malformed `snfn_cids` → log to `warnings_json`, skip CID, keep edge.
- XLSX export with 0 impact rows → return XLSX with header + "No impact rows" sentinel; do not 404.
- Saved View migration runs after enum value re-use — `ADD VALUE IF NOT EXISTS` is idempotent.

## Testing strategy (TDD)

- **Unit** (vitest, no containers): `parseCidList`, `parseProtectionCid`, `stripSpanSuffix`, `roleSummaryCounts`, XLSX cell escaping (mirror `csv.test.ts`).
- **Integration** (testcontainers Postgres + Neo4j): full DWDM ingest end-to-end with 50-row fixture; verify edges, properties, CID upsert, both-direction dedup; verify rules #19/20/21/27/28 each.
- **API integration**: `/api/snfn`, `/api/dwdm`, `/api/dwdm/graph`, `/api/impact/[deviceId]/xlsx`. RBAC contract: extend `apps/web/test/admin-rbac.int.test.ts` `ROUTES` table per the CLAUDE.md pitfall.
- **E2E** (Playwright): DWDM list → node topology → edge click → SNFN overlay; impact → save view → reopen.

## YAGNI / out of scope

- No `:DWDM_LINK` weight (no ISIS cost on DWDM links).
- No SNFN dashboards (PRD-deferred to v2.1).
- No DWDM ring health alerting (Tempo/Sift territory).
- No CID-to-customer reverse lookup UI (PRD §user story 16 is "edge click → CIDs", not "CID search").
- No `:Interface` nodes (still edge properties only, per CLAUDE.md pitfall).

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Inferred `public.dwdm` schema mismatches real source | high | Document inferred schema, ship with feature flag if needed; first prod ingest will surface mismatch in `ingestion_runs.warnings_json` |
| `exceljs` adds large dependency | medium | Constrain to `lib/xlsx.ts`; alternative: `xlsx-populate` or write OOXML by hand (rejected — slower) |
| Enum migration on warm DB | low | `ADD VALUE IF NOT EXISTS` is non-locking in Postgres ≥12 |
| Single PR is huge | medium | Plan structures commits as atomic per-feature so reviewer can read them in order; CI runs full suite |

## PR strategy — split into 4 sub-PRs

Issue #61 stays open until PR 4 lands. Each sub-PR `Refs #61`; only PR 4 `Closes #61`.

| # | Title | Scope | Depends on | Closes ACs |
|---|---|---|---|---|
| 1 | `feat: DWDM ingest + /dwdm pages + CID parser (#61, PR 1/4)` | source/dwdm.ts, cid.ts, dedup, writer (`:DWDM_LINK` + `:CID`), `/dwdm` list + `/dwdm/[node]` + `/dwdm/ring/[ring]`, `/api/dwdm` + `/api/dwdm/graph`, ADR 0005, source-schema doc, contract rules #19/20/21/27/28 | — | ACs 1–4 |
| 2 | `feat: SNFN edge overlay on topology canvases (#61, PR 2/4)` | `/api/snfn`, `<SnfnOverlay>` shared component, wire into `/topology` + `/dwdm/*` | PR 1 (needs `:DWDM_LINK` data) | AC 5 |
| 3 | `feat: impact XLSX export + role-summary header (#61, PR 3/4)` | `lib/xlsx.ts`, `/api/impact/[deviceId]/xlsx`, role-summary rows | — (parallelisable with 1+2) | ACs 6, 7 |
| 4 | `feat: saved_views.kind extension + impact/topology Save (#61, PR 4/4)` | enum migration, `lib/saved-views.ts` zod, Save View buttons on `/impact/[deviceId]` + `/topology`, My Views dropdown extension. **`Closes #61`.** | PR 3 (Save button slot on impact page) | ACs 8, 9, 10 |

Every PR: TDD per criterion, agent-pipeline, verification-before-completion, RBAC `ROUTES` table extended for any new admin route. CLAUDE.md pitfalls list updated as new traps surface.

**This session implements PR 1 only.** Subsequent `/issues-to-complete` sessions pick up PR 2 → PR 3 → PR 4 in order.

## Out-of-issue debt callouts

- `.env.example` carries an uncommitted local `CLICKHOUSE_ISIS_TABLE` / `CLICKHOUSE_TIMEOUT_MS` placeholder block — owned by issue #67, **not** this PR. Will leave untouched and unstaged across the slice's commits.
- ADR 0004 (`docs/decisions/0004-isis-weight-policy.md`) is #67's territory; not edited here.
