# 0005 — DWDM data model and `protection_cid` correction

**Status:** Accepted (PR 1 of issue #61, slice 4)
**Date:** 2026-04-25
**Issue:** #61
**Supersedes:** —

## Context

Issue #61 (slice 4) adds DWDM topology and customer-circuit (CID) data
to V2. Two source-DB tables drive this: `public.dwdm` (DWDM spans
keyed by device pair) and `public.app_cid` (CID master with capacity,
endpoints, protection metadata).

V1's `Topo.py:914-920` and `dwdm_view.py:54-60` showed two surprises
worth pinning down before V2 mirrored the model:

1. **`protection_cid` is sourced from `app_cid`, not from `dwdm`.** V1
   loads it alongside the CID master and uses `.split()[0]` to pick the
   first protection CID for path-display labels. The PRD §142 wording
   ("DWDM ring with protection") suggested it lived on the DWDM edge;
   the V1 ground truth contradicts that.
2. **V1's span-name suffix stripper had an unreachable `elif` branch.**
   The original code stripped ` -  LD` (note: two spaces before LD)
   in the `if`, then attempted ` - NSR` in an `elif` that never ran
   when the first branch matched. Most spans only carry one suffix in
   practice, but the bug means rows with both never had the second
   stripped. Contract rule #27 requires V2 to strip both independently.
3. **V1's CID load was `CID.objects.create(...)` — no upsert.** Re-runs
   produced duplicate CID rows. Contract rule #28 requires V2 to
   MERGE on `cid`.

The graph already has `:CONNECTS_TO` edges for LLDP topology. Two
possible models for DWDM:

- **Property on `:CONNECTS_TO`** — overload the existing edge.
- **Separate `:DWDM_LINK` relationship type** — parallel edge between
  the same device endpoints.

DWDM and LLDP are physically different layers (optical transport vs.
L2 adjacency) and the queries differ — ring traversal, span-name
filtering, CID lookup are DWDM-only. Mixing them on one edge would
require every `:CONNECTS_TO` query to filter by presence-of-DWDM-props
and would corrupt the weighted shortest-path work in issue #67 (which
assumes one-edge-per-hop with a single weight).

## Decision

**DWDM model.** Store DWDM as a separate `:DWDM_LINK` relationship
type between `:Device` nodes:

```
(:Device {name})-[:DWDM_LINK {
  ring,
  snfn_cids,        // string[]
  mobily_cids,      // string[]
  span_name,        // suffixes stripped per rules #19/#27
  src_interface,
  dst_interface
}]->(:Device {name})
```

Edges are keyed by canonical unordered `{(device_a_name,
device_b_name)}` (same dedup rule as LLDP). Self-loops and rows with
NULL `device_a_name` / `device_b_name` are dropped. Multi-row anomalies
keep the latest row.

`span_name` has its V1 suffixes stripped before write:

- ` -  LD` (two spaces before LD — V1 contract rule #19)
- ` - NSR` (V1 contract rule #27 — fixes V1's unreachable-`elif` bug)

Both branches run independently in V2 (`stripSpanSuffix` in
`apps/ingestor/src/cid-parser.ts`).

**`protection_cid` lives on `:CID` nodes, NOT on `:DWDM_LINK`.** This
corrects the wording in PRD §142. V1 ground truth (`Topo.py:914-920`)
loads `protection_cid` from `app_cid` rows alongside the CID master,
not from DWDM. V2 mirrors this: the value is parsed via
`parseProtectionCids` (space-split, order-preserving, `'nan'` /
empty / null → `[]`) and stored as `protection_cids: string[]` on the
`:CID` node.

**`:CID` node MERGE-upsert.** Contract rule #28 fixes V1's
`CID.objects.create()` non-idempotency bug. V2's writer:

```cypher
MERGE (c:CID {cid: $cid})
SET c.capacity = $capacity,
    c.source = $source,
    c.dest = $dest,
    c.bandwidth = $bandwidth,
    c.protection_type = $protection_type,
    c.protection_cids = $protection_cids,
    c.mobily_cid = $mobily_cid,
    c.region = $region
```

Re-running the nightly ingest is idempotent — same input, same node
count, no duplicates.

## Consequences

- **Weighted shortest-path (issue #60 / #67) is unaffected.** DWDM is
  a parallel relationship type; `:CONNECTS_TO` traversals do not see
  `:DWDM_LINK` edges and the ISIS weight set lives only on
  `:CONNECTS_TO`.
- **Topology pages opt into DWDM explicitly.** The `/dwdm/*` routes
  match `(:Device)-[:DWDM_LINK]->(:Device)`; the existing path / blast-
  radius views stay on `:CONNECTS_TO` and are not affected by DWDM
  ingest enable/disable.
- **CID protection chains query directly.** Operators looking for
  "what CIDs protect CID X?" hit `:CID {cid: $x}.protection_cids`
  without joining through edges. UIs that need the V1 single-CID
  display value index `[0]` explicitly; we preserve the full list so
  future UIs can show alternates.
- **Ring-topology queries are first-class.** `:DWDM_LINK.ring` is
  indexed; ring sub-graph endpoints (issue #61 PR 1 web slice) match
  on the `ring` property without a join through CID nodes.
- **CSV exports are direct.** The `/api/dwdm` tabular endpoint reads
  edge properties verbatim (`span_name`, `snfn_cids`, `mobily_cids`,
  `ring`, interfaces); no CID join needed for the list/by-node/by-ring
  views.

## V1 mapping notes

| V1 source | V2 implementation |
|---|---|
| `dwdm_view.py:54-60` (raw `public.dwdm` SELECT, quoted `"Ring"`) | `apps/ingestor/src/source/dwdm.ts` — preserves `"Ring"` AS `ring` projection |
| `Topo.py:914-920` (CID load + `protection_cid.split()[0]`) | `apps/ingestor/src/cid-parser.ts::parseProtectionCids` — order-preserving full list; callers pick `[0]` if needed |
| `data_populate.py:36-42` (span-name suffix stripping) | `apps/ingestor/src/cid-parser.ts::stripSpanSuffix` — both LD and NSR branches independent (fix for V1 unreachable `elif`) |
| `CID.objects.create(...)` (Django ORM, no upsert) | MERGE-on-`cid` in writer (`apps/ingestor/src/graph/writer.ts`); regression-guarded by `apps/ingestor/test/dwdm-cid.int.test.ts` ":CID nodes: MERGE-upsert is idempotent (rule #28)" |
