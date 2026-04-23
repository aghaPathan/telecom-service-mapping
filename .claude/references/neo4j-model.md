# Neo4j model (reference — read before writing Cypher)

## Nodes + edges

```cypher
(:Device {name, vendor, domain, site, role, level, ip, mac})
  // + secondary label per role. Note: the role string from config/hierarchy.yaml is
  // applied verbatim as a label, which means labels are UPPERCASE (:CORE, :IRR,
  // :VRR, :UPE, :CSG, :MW, :SW, :RAN, :PTP, :PMP, :Customer, :Unknown) — NOT :Core.
  // Filter by `level` property, never by `:Core`.
(:Site    {name, category, url})
(:Service {cid, mobily_cid, bandwidth, protection_type, region})

(:Device)-[:CONNECTS_TO {a_if, b_if, trunk, updated_at}]-(:Device)   // semantically undirected
(:Device)-[:LOCATED_AT]->(:Site)
(:Service)-[:TERMINATES_AT {role: 'source'|'dest'}]->(:Device)
(:Service)-[:PROTECTED_BY]->(:Service)
```

## Constraints / indexes (created by `apps/ingestor/src/graph/writer.ts` phase 2)

- Unique: `Device(name)`, `Site(name)`, `Service(cid)`
- Fulltext: `device_name_fulltext` on `Device(name)`
- Btree: `device_role`, `device_domain`, `device_site`, `device_vendor`, `device_level`, `service_mobily_cid`

`Device.site` is derived from the hostname (first two hyphen-tokens, e.g. `PK-KHI-CORE-01` → `PK-KHI`) and always equals the `:Site` node's name for the `LOCATED_AT` target — filter by either interchangeably. `Device.vendor` prefers the hostname-derived canonical vendor from `parseHostname` + `config/role_codes.yaml` `vendor_token_map` (e.g. `NO01` → `Nokia`); it falls back to the source row's `vendor_a`/`vendor_b` when the third hyphen-token isn't mapped or the hostname doesn't follow the `SITE-ROLE-VENDOR<SERIAL>` convention.

## Edge-direction rule

`:CONNECTS_TO` is stored directionally (`a → b`, canonical lesser→greater by `level`) but MUST be traversed undirected (`-[:CONNECTS_TO]-`) in every query. To pick the `a_if` vs `b_if` for a given node, match by node name against `startNode(r).name` / `endNode(r).name` — never by traversal direction. See `faceOf`/`pickInOut` in `apps/web/lib/path.ts` for the canonical pattern.

## Hierarchy levels (from `config/hierarchy.yaml`)

| Level | Label | Roles |
|---|---|---|
| 1 | Core | CORE, IRR, VRR |
| 2 | Aggregation | UPE |
| 3 | CustomerAggregation | CSG, GPON, SW |
| 3.5 | Transport | MW |
| 4 | Access | RAN, PTP, PMP |
| 5 | Customer | Customer |
| 99 | (unknown) | Unknown |

SW is re-leveled post-ingest based on topology (→CORE = L2, →RAN/Customer = L4, else L3).

## Common resolver patterns (already implemented — reuse)

- **Path trace** (`apps/web/lib/path.ts`) — `shortestPath` with monotonic **non-increasing** level predicate (`>=`), core terminator `level = 1`. MW-MW peer hops at equal level are allowed.
- **Downstream / blast-radius** (`apps/web/lib/downstream.ts`) — variable-length walk with **strict <** level predicate; MW (3.5) filtered POST-collection (`WHERE $include_transport OR dst.level <> 3.5`) so paths still traverse through MW.
- **Omnibox** (`apps/web/lib/search.ts`) — cascade: `Service.cid` → `Service.mobily_cid` → exact `Device.name` → fulltext. Lucene input is tokenized on non-alphanumerics, escaped per token, `*` appended, AND-joined.

## Session + access mode

- `getDriver()` from `@/lib/neo4j` is a lazy singleton — never create your own driver.
- Read-only queries: `driver.session({ defaultAccessMode: "READ" })`.
- `await session.close()` in `finally` — no exceptions.

## Variable-length bounds are NOT parameterizable

Neo4j rejects `$maxDepth` inside `*1..N`. Zod-validate the integer (`.int().min(1).max(K)`) then interpolate the validated integer into the query string. Existing constants: `MAX_PATH_HOPS = 15` (path.ts), `MAX_DOWNSTREAM_DEPTH = 15` (downstream.ts). Never make these configurable from user input or env.
