# 0004 — ISIS weight policy and pure-Cypher shortest-path

**Status:** Accepted (PR 1 of #60; PR 2 closed by #67)
**Date:** 2026-04-25
**Supersedes:** —

## Context

Issue #60 asks path-trace to honour ISIS edge cost and to support
device-to-device queries. V1 used NetworkX Dijkstra over an in-memory
graph loaded from a pickled `Topology.obj`; V2 stores the graph in Neo4j
and resolves paths inside the request cycle.

Data investigation (April 2026) against the live source databases
found:

- `lldp_data.isis_cost` in ClickHouse (V1's receive log, reachable from
  this host) currently carries **Huawei-only** weights, ~815k append
  rows, last `RecordDateTime` **2025-02-14** (~14 months stale). The
  upstream pipeline is expected to be repaired; until then, coverage is
  partial and the data is a frozen snapshot.
- `app_lldp` (733,700 rows) has no bandwidth column. Interface names
  that encode bandwidth (GigabitEthernet / TenGigE / HundredGigE /
  FortyGigE / Juniper `ge-` `xe-` `et-`) cover only **~6.3%** of rows.
  The remaining ~94% are bare `Ethernet…` / aggregates (`Eth-Trunk`,
  `LAG`) / access-gear patterns (`Network-`, `Port`, `TN`, `microwave-`,
  `PON`, `ODN`, `gei-`, `esat-`) / empty prefixes. Deriving weight
  synthetically from the name is not viable.
- The CH `Device_*_Trunk_Name` column format (numeric IDs like `202.0`,
  `1045.0`) does not match the LLDP `device_a_trunk_name` format (free
  text like `OM_WRAN`, `LAG 23`, `facing_to_MW`, `po24`); `app_lldp`
  also has no `device_b_trunk_name` column. Trunk columns are therefore
  unusable as a cross-source join key — interface columns are required
  on both sides.
- Neo4j 5 Community has no plugins installed (`/var/lib/neo4j/plugins/`
  holds only a README). `apoc.algo.dijkstra` lives in APOC **Extended**
  (not Core), and GDS requires a graph projection step. At ~250k edges
  with a `*..15` hop cap, pure-Cypher enumeration plus `reduce()` over
  candidate paths is within budget.

The network topology itself has two conceptually different regions:
an IP-routed core (where ISIS actually runs and a routing metric is
meaningful) and an access / microwave / PON / L2 CPE region (where the
device is not making a routing decision and hop count is semantically
the correct model). Any weight strategy must degrade cleanly in the
second region.

## Decision

**Algorithm.** Weighted shortest-path is pure Cypher: enumerate
variable-length paths `(start)-[:CONNECTS_TO*1..${MAX_PATH_HOPS}]-(end)`
bounded by a level predicate, compute `total_weight` per candidate as
`reduce(t = 0.0, w IN relationships(p) | t + w.weight)` (null when any
edge weight is null), aggregate across the candidate set, and order by
`total_weight NULLS LAST, hops ASC, LIMIT 1`. No APOC, no GDS, no
plugin dependency.

Note: `shortestPath(...)` was considered and rejected because it
returns only hop-minimum paths — a 2-hop route with total weight 20
would always beat a 3-hop route with total weight 3. Full variable-length
enumeration is required.

**Set-level null propagation.** If **any** candidate in the set has a
null edge weight, the effective total for every candidate is set to
null — the whole result is reported as `weighted=false` and the UI
surfaces the fallback banner. Rationale: partial coverage is the steady
state, and when the candidate set is mixed we cannot claim the chosen
weighted path is the globally cheapest; hop count becomes the more
defensible tie-breaker and the banner makes the honesty visible.

**Edge schema.** `:CONNECTS_TO { weight: float|null, ... }`. Null means
"no observed ISIS cost for this edge" — the hop is still valid, it just
has no weight. Adding `weight_source`, `weight_observed_at`, and a
per-vendor diagnostic column is deferred to PR 2 when the ClickHouse
ingest actually has values to attribute.

**Edge-match key (PR 2).** The join between ClickHouse `isis_cost` and
the Neo4j `:CONNECTS_TO` edge is the canonical unordered pair on both
sides: `{(Device_A_Name, Device_A_Interface), (Device_B_Name,
Device_B_Interface)}`. Trunk columns are not used. Interface is present
and consistent on both sides; trunk is not.

**Fallback.** If any candidate has a null edge weight (per the set-level
rule above), the resolver picks the minimum-hop path and emits
`weighted: false, total_weight: null, edge_weight_in: null` on every
hop. The UI surfaces this explicitly as an informational banner — not
a warning. Partial coverage is expected until the upstream ISIS
pipeline onboards all vendors.

**Device-to-device predicate.** For same-level endpoints the monotonic
`level[i] >= level[i+1]` predicate degenerates to "no movement allowed"
and fails (no path through a higher-level device is admitted). We
replace it with a corridor: `level ∈ [min(src,tgt).level − 1,
max(src,tgt).level + 1]`. For cross-level endpoints the corridor
collapses to the same admissible envelope as the monotonic predicate
over the relevant range.

## Consequences

- **PR 1 ships with `weight=null` on every edge** (no ingestion yet).
  Production traffic will always exercise the fallback path. Tests seed
  weights directly in Neo4j to cover the weighted branch and the
  set-level null propagation.
- **PR 2** introduces a ClickHouse client, writes `weight` on the
  `:CONNECTS_TO` edge during the existing nightly ingest (plus an
  admin-triggered on-demand refresh) and adds an admin freshness badge
  showing `max(RecordDateTime)` and per-edge coverage. No algorithm
  change in PR 2.
- **Cross-vendor metric-scale mismatch** (narrow cost ~10 vs. wide cost
  ~100,000 when multiple vendors are present) is a known limitation —
  documented, not coded. A v2.1 ticket will add a diagnostic query that
  flags vendor mix on chosen paths so operators can judge.
- **Access / microwave / L2 regions** remain hop-count forever, because
  ISIS doesn't run there. The banner fires for paths that traverse
  them, and this is correct — operators should know the path under
  those hops is not weight-informed.
- **Pure Cypher is within budget** today (~250k edges, `*..15` cap).
  If graph growth pushes query latency past SLO, the replacement is
  APOC Extended (`apoc.algo.dijkstra`) — a plugin install, not an
  algorithm rewrite. The corridor / set-level / edge schema decisions
  above are algorithm-neutral.
- **V1 parity in spirit.** V1 ran NetworkX Dijkstra over observed
  weights with a silent `weight=1` fallback for missing edges. V2 makes
  the fallback explicit and visible rather than silent, keeping the
  same spirit but surfacing partial coverage as a UX concern rather
  than burying it as a default.

## PR 2 closure (2026-04-25, issue #67)

PR 2 fills the data side of the policy decided in PR 1. No algorithm
change.

**Edge schema (final).**

- `weight: float | null` — unchanged from PR 1.
- `weight_source: 'observed' | null` — set to `'observed'` when an ISIS
  row matched the canonical edge pair; left null otherwise. Per-vendor
  refinements (e.g. `'observed:huawei'`) remain deferred until the
  upstream pipeline onboards more vendors.
- `weight_observed_at: datetime | null` — the latest `RecordDateTime`
  from ClickHouse for that canonical pair.

**Edge-match key (confirmed).** Canonical unordered pair
`{(Device_A_Name, Device_A_Interface), (Device_B_Name, Device_B_Interface)}`.
Implemented as a JS-side fold in `apps/ingestor/src/isis-cost-dedup.ts`
on top of the ClickHouse `argMax(ISIS_COST, RecordDateTime) GROUP BY`
projection in `apps/ingestor/src/source/isis-cost.ts`. Trunk columns
are not used (per PR 1 context).

**ClickHouse failure isolation.** A CH connection error or query failure
during a full ingest run is captured as a `warnings_json` entry of the
form `{kind: 'isis_cost_failure', error: <msg>}`; the run still
finishes `succeeded`. Existing edges keep whatever state the LLDP
rebuild produces — concretely `weight=null` for this run, because the
LLDP refresh always rebuilds the graph from scratch. **The ISIS stage
never sets `weight=null`** — it only writes observed values. Absence of
a weight is the LLDP rebuild's default, not an ISIS-stage clear.

**Per-edge coverage / freshness signals.** `getIsisFreshness()` in
`apps/web/lib/isis-status.ts` computes:

- `coverageFraction` — fraction of `:CONNECTS_TO` edges with
  `weight IS NOT NULL` over total edges.
- `latestObservedAt` — `max(weight_observed_at)` across all weighted
  edges.

Surfaced on `/admin/ingestion` as a freshness badge that turns amber
when `latestObservedAt` is more than 30 days stale.

**On-demand refresh.** `ingestion_triggers` gains a `flavor` column.
Admins can enqueue an ISIS-only run that skips the LLDP rebuild via
`runIngest({flavor: 'isis_cost'})`; the cron's `claimNextTrigger` path
honours both `flavor` and `dryRun`.

**Out of scope, still deferred.**

- Per-vendor weight diagnostic and metric-scale normalization across
  vendors — still v2.1.
- Algorithm changes in `apps/web/lib/path.ts` — none in PR 2; PR 1's
  algorithm was already correct, this PR fills the data side only.
