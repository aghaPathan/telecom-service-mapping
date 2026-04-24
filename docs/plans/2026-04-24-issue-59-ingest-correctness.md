# Issue #59 — Ingest Correctness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock the V1 ingest-behavior contract into V2 so "different figures" becomes a test failure, not a mystery — 31 edge-case rules tagged Port/Fix/Reject, with tests for every Port, explicit regression tests for every Fix, and scoped deferrals for rules that depend on features not yet built.

**Architecture:** Three areas of change. (1) Ingestor pipeline: extend dedup + resolver + writer for multi-label `tags[]`, `wiconnect→wic` alias, 8-digit numeric node handling, `status=false` exclusion moved into the source read, unresolved-token counter rollup, and the CLAUDE.md-flagged SW dynamic-leveling Cypher driven by `level` instead of hardcoded labels. (2) Config surface: new `tag_map` block in `config/hierarchy.yaml` (Zod-optional, additive) and a new `vendor_aliases` block in `config/role_codes.yaml`. (3) UI null-as-null contract: remove `?? 0` fallbacks from the freshness badge and the device-list CSV exporter; add a small `formatNullable` helper used consistently. All V1 rules that need a CID loader (LD/NSR suffix stripping, `'nan'` protection CID, CID upsert) are deferred to Slice 4 (DWDM, #61) where the CID loader naturally lands; all rules that belong to path-trace query layer (`UPLINK_EXCLUDE_LIST`, main-graph threshold) are deferred to Slice 3 (weighted + d2d, #60). Scope boundary is called out in every commit message and in the PR body.

**Tech Stack:** TypeScript (strict), Zod for config validation, node-pg-migrate (no migration required — `warnings_json` is already `jsonb`), Neo4j (Cypher via existing driver), Vitest + testcontainers (real Postgres + Neo4j — no mocks), React + Tailwind (UI null-rendering).

**References:**
- Issue: https://github.com/aghaPathan/telecom-service-mapping/issues/59
- Parent PRD: `docs/prd/v2-from-v1.md` §"V2 Ingest Edge-Case Contract" and §"NetworkX → Cypher Translation"
- CLAUDE.md pitfalls that apply: SW-label rename silent no-op; `@tsm/db` rebuild-before-use; fixture coupling to `role_codes.yaml` `type_map`.

---

## Scope boundary (read first)

The issue's acceptance criteria name "31 rules + 4 V1 bug fixes + tags + null-as-null UI." After exploring the code, we found:

- **7 of 31 rules** already implemented AND tested (dedup nulls, self-loops, anomaly, symmetric-merge, casing, first-non-null field merge, role resolution priority). These need **contract-name tests** so the rule IDs are discoverable by the naming convention `rule[PORT|FIX|REJECT]: <rule>`.
- **6 rules** implemented without dedicated contract tests (single edge per A→B, blank-type name-token fallback, Unknown bucket, Zod fail-fast, etc.). These need **new contract tests only**.
- **4 rules** depend on a CID loader that V2 does not have yet (LD/NSR suffix stripping, `'nan'` protection CID, CID upsert, protection-CID space-split). **Deferred to Slice 4 (#61 DWDM)** — explicitly called out in that slice's PRD entry.
- **2 rules** are query-layer path-trace concerns (`UPLINK_EXCLUDE_LIST` exclusion, main-graph weakly-connected-component threshold). **Deferred to Slice 3 (#60 weighted paths)** because that slice rewrites the path Cypher.
- **1 rule** (SAI Ping BNG Master/Slave failover) is **Rejected** by PRD and stays a no-op in V2.
- **Remaining ~11 rules** are genuinely new work in this slice: tags, vendor-aliases, status filter, 8-digit node, RAN service dict, unresolved-token rollup, topology_devices view fallback, SW leveling by level, null-as-null UI contract (2 spots), V1-bug regression tests (2 of 4 where the code path exists in V2).

The PR description will list each rule with its status so reviewers can check off every one of the 31.

---

## Pre-flight

Before starting Task 1:

1. Confirm on branch `feat/issue-59-ingest-correctness` (create if absent).
2. Baseline green: `pnpm -r typecheck`, `pnpm --filter web test -- --run`, `pnpm --filter ingestor test -- --run`. All must pass.
3. Re-read issue acceptance criteria: `gh issue view 59`.

---

## Task 1: Test naming convention + contract helpers

**Purpose:** Make the 31 rules discoverable in test output. Every contract test title starts with `rule[PORT|FIX|REJECT]: <one-line description>` so a future `pnpm test | grep rule` produces a compliance matrix.

**Files:**
- Create: `apps/ingestor/test/contract/README.md` — one-liner explaining the convention + a table of all 31 rules with their status.

**Steps:**

1. Write the README table with all 31 rules from PRD §"V2 Ingest Edge-Case Contract" plus status (Port/Fix/Reject) plus the file that covers each rule (blank for rules covered in later tasks).
2. Commit: `docs: rule contract convention for ingest edge cases (#59)`.

---

## Task 2: Existing rules → name-tagged regression tests

**Purpose:** The 7 rules that already pass tests get contract-named aliases in dedup test so the PR body can link them.

**Files:**
- Modify: `apps/ingestor/test/dedup.test.ts` — add `describe("ingest contract: dedup", ...)` block with 7 `it("rulePORT: …")` entries that call existing asserts with new names. Do NOT delete the existing tests — add aliases.

**Steps:**

1. Open `dedup.test.ts`. Write a new `describe("ingest contract: dedup", ...)` block that imports the same helpers and asserts the same behavior but uses the naming convention. Each rule:
   - `rulePORT: null device_b rows dropped and counted`
   - `rulePORT: self-loop rows dropped and counted`
   - `rulePORT: anomaly (>2 rows same key) keeps latest updated_at`
   - `rulePORT: symmetric (both-direction) pair merged to one link`
   - `rulePORT: first-seen casing wins for device name`
   - `rulePORT: first-non-null field merge (vendor / domain / ip / mac)`
   - `rulePORT: single edge per A→B hop (simple DiGraph)` — add assertion that two dedup-keyed rows merge
2. Run: `pnpm --filter ingestor test dedup -- --run`. Expect all pass.
3. Commit: `test: rule-tagged regression tests for existing dedup contract (#59)`.

---

## Task 3: Existing rules (resolver) → name-tagged regression tests

**Files:**
- Modify: `apps/ingestor/test/resolver.test.ts` — new `describe("ingest contract: resolver", ...)` block with aliases.

**Rules covered:**
- `rulePORT: resolver priority type_column → name_token → fallback`
- `rulePORT: Unknown bucket for unmapped codes`
- `rulePORT: blank type_* falls back to name_token` (covers V1's 33% blank observation)
- `rulePORT: role referenced in role_codes.yaml but missing from hierarchy.yaml → Unknown` (silent fallback documented)
- `rulePORT: name_prefix fallback (back-compat)`

**Steps:**

1. Write aliased tests.
2. Run `pnpm --filter ingestor test resolver -- --run`. PASS.
3. Commit: `test: rule-tagged regression tests for existing resolver contract (#59)`.

---

## Task 4: Vendor alias map (`wiconnect → wic`)

**Purpose:** V1 `IsolationSummary` normalizes `wiconnect` vendor to `wic` for display. V2 must normalize at ingest so downstream KPIs agree across surfaces.

**Files:**
- Modify: `config/role_codes.yaml` — add `vendor_aliases:` map block: `wiconnect: wic` (+ documented placeholder for future aliases).
- Modify: `apps/ingestor/src/resolver.ts` — extend `RoleCodesSchema` with `vendor_aliases: z.record(z.string(), z.string()).optional().default({})`. Expose on `ResolverConfig`.
- Modify: `apps/ingestor/src/dedup.ts` — in the merge pass, apply `vendorAlias(vendor)` before storing.
- Modify: `apps/ingestor/test/dedup.test.ts` — new `rulePORT: wiconnect → wic vendor alias` test. Seed a row with `vendor_a = "wiconnect"` and assert dedup output has `vendor === "wic"`.
- Modify: `apps/ingestor/test/fixtures/lldp-50.ts` — if any row has `wiconnect`, keep its alias expectation in step with updated dedup output (CLAUDE.md pitfall: fixture coupling).

**Steps:**

1. Write failing test.
2. Extend Zod schema + default value so existing tests with no `vendor_aliases` block don't break.
3. Plumb alias function through dedup.
4. Run: `pnpm --filter ingestor test -- --run`. All pass.
5. `pnpm --filter @tsm/db build` (no-op for this change but confirms workspace OK).
6. Commit: `feat: vendor alias map (wiconnect→wic) applied in dedup (#59)`.

---

## Task 5: `tag_map` config + resolver tags[] output

**Purpose:** Multi-label classification — a `RGUF` device should count against both 3G and 4G in reporting views. V2's primary label stays exclusive; tags are a cross-cutting array.

**Files:**
- Modify: `config/hierarchy.yaml` — append a documented `tag_map:` block with 4 example mappings from the V1 Topo.py regex multi-label rules (e.g., `RGUF: [3G, 4G]`).
- Modify: `apps/ingestor/src/resolver.ts` — extend `HierarchySchema` with `tag_map: z.record(z.string(), z.array(z.string()).min(1)).optional().default({})`. Compute `tags: string[]` in `finalize()` by looking up the device's detected role or name-token against `tag_map`; default `[]`.
- Modify: `apps/ingestor/src/dedup.ts` — add `tags: string[]` to `DeviceProps`. Dedup does not touch tags (resolver step sets them); ensure the shape propagates.
- Modify: `apps/ingestor/test/resolver.test.ts` — new tests:
  - `rulePORT: tag_map produces tags[] for multi-tech devices`
  - `rulePORT: device with no matching tag_map key gets tags: []`

**Steps:**

1. Write failing tests.
2. Add Zod default + resolver computation.
3. Run: `pnpm --filter ingestor test resolver -- --run`. PASS.
4. `pnpm --filter ingestor typecheck`.
5. Commit: `feat: tag_map multi-label classification in resolver (#59)`.

---

## Task 6: Writer — persist tags[] on :Device + index

**Files:**
- Modify: `apps/ingestor/src/graph/writer.ts` — extend device MERGE Cypher SET clause: `x.tags = d.tags`. Add `CREATE INDEX IF NOT EXISTS device_tags FOR (d:Device) ON (d.tags)` to the constraints/indexes phase.
- Modify: `apps/ingestor/test/ingest.int.test.ts` — update the existing post-write assertions that inspect device properties to include `tags` (existing fixture rows: `tags: []` for unmapped; one fixture row updated to land a `tag_map` entry and assert `tags: ["3G","4G"]`).

**Steps:**

1. Check current fixture in `apps/ingestor/test/fixtures/lldp-50.ts` — identify one row whose role qualifies for a multi-label tag. Update `config/hierarchy.yaml` so `tag_map` includes it.
2. Write/update failing test: after `runIngest()`, `MATCH (d:Device {name: "...known row..."}) RETURN d.tags` returns the expected array. Also assert devices with no mapping have `tags: []`.
3. Implement SET + index.
4. Run: `pnpm --filter ingestor test ingest.int -- --run`. PASS.
5. `pnpm -r typecheck`.
6. Commit: `feat: persist tags[] on Device node with index (#59)`.

---

## Task 7: `status=false` exclusion at source

**Purpose:** V1 rule 5 (PRD). Source LLDP rows with `status=false` are soft-deleted / inactive; V2 must NOT ingest them.

**Files:**
- Modify: `apps/ingestor/src/source/lldp.ts` — add `WHERE status = true OR status IS NULL` to the SELECT. `status IS NULL` path kept because early V1 migrations had nullable status — we don't want to drop real rows on schema drift.
- Modify: `apps/ingestor/test/lldp-source.int.test.ts` — new test: seed two rows (one `status=true`, one `status=false`) and assert `readActiveLldpRows` returns only the active one.

**Steps:**

1. Write failing int test.
2. Add WHERE clause.
3. Run int test.
4. Commit: `feat: exclude status=false rows at LLDP source (#59)`.

---

## Task 8: SW dynamic-leveling — level-driven, not label-driven

**Purpose:** V1 bug in V2: `writer.ts:398-414` hardcodes `:CORE`, `:RAN`, `:Customer`. Rename a role in `hierarchy.yaml` and SW leveling silently stops working. Fix by reading `level` property instead.

**Files:**
- Modify: `apps/ingestor/src/graph/writer.ts` — replace:
  - `any(n IN nbrs WHERE n:CORE)` → `any(n IN nbrs WHERE n.level = 1)`
  - `any(n IN nbrs WHERE n:RAN OR n:Customer)` → `any(n IN nbrs WHERE n.level >= $accessLevel)` where `$accessLevel` is interpolated (Cypher doesn't accept parameter in some positions; verify and interpolate cleanly). The threshold comes from `hierarchy.yaml` — the lowest level classified as "access tier". If unclear, pick `5` (Access) with a comment and make it a constant at the top of the file.
  - `toCore=2`, `toAccess=4` magic numbers: leave as constants but comment their origin.
- Add: `apps/ingestor/test/ingest.int.test.ts` — new test `ruleFIX: SW leveling driven by level, not label` — seed a graph with a `:SW` device between a level-1 core and a level-5 access device, where the core label is custom (e.g., `:CORETEST` instead of `:CORE`); assert the SW gets `level: 2` (toCore). This is the regression test for the CLAUDE.md pitfall.
- Optional safety test: rename a role in a test-only hierarchy.yaml and confirm SW leveling still works.

**Steps:**

1. Write failing regression test.
2. Modify Cypher to use `n.level` predicates.
3. Run: `pnpm --filter ingestor test ingest.int -- --run`. PASS.
4. Commit: `fix: SW dynamic-leveling driven by level property, not hardcoded labels (#59)`.

---

## Task 9: Unresolved role-token counter rollup

**Purpose:** PRD rule: ingestor should emit top-N unresolved role tokens in `warnings_json` so data-quality stewards can see trending.

**Files:**
- Modify: `apps/ingestor/src/resolver.ts` — expose a helper `summarizeUnresolved(resolveds: ResolvedRole[]): Array<{token: string; count: number}>` that buckets by `unresolved_name_token` (null → skip), returns top 20 by count.
- Modify: `apps/ingestor/src/index.ts` — after resolver runs, compute the summary and append to the warnings array passed to `finishRun`, shape: `{ kind: "unresolved_role_tokens", entries: [...] }`.
- Modify: `apps/ingestor/test/resolver.test.ts` — new test `rulePORT: unresolved tokens rolled up to top-N`.
- Modify: `apps/ingestor/test/ingest.int.test.ts:373` — the `warnings_json` length assertion may break. Update to assert structure: either anomaly entries or unresolved_role_tokens entries are present; do not assert exact length.

**Steps:**

1. Write failing unit test.
2. Implement helper.
3. Wire into pipeline.
4. Update int test assertions.
5. Run: `pnpm --filter ingestor test -- --run`. All pass.
6. Commit: `feat: roll up unresolved role tokens into warnings_json (#59)`.

---

## Task 10: 8-digit numeric node special-casing (jumper / business customer)

**Purpose:** V1 rule 9 (PRD). A device name matching `^\d{8,}$` is treated as a business-customer / jumper node. V1 adds predecessor edges temporarily before path computation; V2's equivalent is to ensure these devices are fully resolvable from both directions at ingest time.

Since V2 path-trace already traverses undirected (`-[:CONNECTS_TO]-` without arrow), the "predecessor bidirectionality" V1 trick is not needed. What IS needed: (a) detect these devices, (b) assign them a deterministic role (e.g., `BusinessCustomer`) when `type_column` and `name_token` both miss, (c) tag them so downstream surfaces can render them differently.

**Files:**
- Modify: `apps/ingestor/src/resolver.ts` — add a pre-check in `resolveRole`: if device name matches `/^\d{8,}$/`, short-circuit to a fixed `{ role: "BusinessCustomer", level: <configured BusinessCustomer level or unknown_level> }` and set `tags: ["business-customer"]`.
- Modify: `config/hierarchy.yaml` — add `BusinessCustomer` to the levels list (or document that it inherits from `unknown_level` if users don't want a formal level).
- Modify: `apps/ingestor/test/resolver.test.ts` — new test `rulePORT: 8-digit numeric node classified as BusinessCustomer`.

**Steps:**

1. Write failing unit test with device names `"12345678"` and `"ABC123"` (latter should NOT match).
2. Add regex check + classification.
3. Run unit.
4. Run int (ingest fixture should keep working; add one 8-digit row to fixture if easy).
5. Commit: `feat: 8-digit numeric nodes classified as BusinessCustomer (#59)`.

---

## Task 11: `topology_devices_view` → `topology_devices_dynamic_view` fallback

**Purpose:** V1 rule 19. Source DB has a static devices view that falls back to a dynamic view when the static is empty.

**Files:**
- Modify: `apps/ingestor/src/source/` — add a new source reader (or extend existing `sites.ts` if it's logically adjacent) that tries `topology_devices_view` first, falls back to `topology_devices_dynamic_view` if the first returns 0 rows. This is used for any stage that needs the full device inventory (today: isolation source reader already uses its own table).
- Actually — if no V2 stage currently reads `topology_devices_view` at all (we read `app_lldp` and derive devices from links), this rule may be **N/A for V2's current architecture**. Investigate: does any V2 stage depend on a devices view? If not, document as N/A in the contract README and open a follow-up if an isolation-source stage (Slice 2 PRD) needs it.

**Decision gate:** Investigation result drives whether this task is a config change or a "documented N/A with follow-up issue." Err on the side of documenting N/A to avoid building unused code.

**Steps:**

1. Grep V2 for any `topology_devices` reference. If none: document in `apps/ingestor/test/contract/README.md` as "N/A — V2 derives device inventory from LLDP links; no devices view is read today."
2. If a reader exists, add the fallback + int test with a seeded empty static view and populated dynamic view.
3. Commit: `docs: topology_devices_view fallback marked N/A for current architecture (#59)` OR `feat: devices-view fallback to dynamic view (#59)`.

---

## Task 12: RAN service code dictionary (22 codes)

**Purpose:** V1 rule 18. `Topo.py:43-67` hard-codes 22 RAN service codes (e.g. "U900", "L2100") used to expand service descriptions in the UI.

**Files:**
- Create: `config/ran_service_codes.yaml` — map from code to human-readable description (copy V1's dictionary with redacted placeholders if real codes are sensitive).
- Modify: `apps/ingestor/src/resolver.ts` — load this map via Zod. If device `type === "Ran"`, look up service description from the code extracted as `name.split("-")[1]`; expose as `service_description` on `ResolvedRole`.
- Modify: `apps/ingestor/src/dedup.ts` + writer — pass `service_description` through; persist on Neo4j `:Device.service_description`.
- Modify: `apps/ingestor/test/resolver.test.ts` — new test `rulePORT: RAN service code dictionary resolves known codes`.

**Steps:**

1. Copy the V1 code dictionary (22 entries) into the new YAML. If codes are real operator identifiers, flag in output — we may need to use placeholders to keep this PR public-reviewable.
2. Extend Zod + resolver.
3. Persist + test.
4. Run: `pnpm --filter ingestor test -- --run`. All pass.
5. Commit: `feat: RAN service code dictionary (#59)`.

---

## Task 13: UI null-as-null contract — `formatNullable` helper + fix two offenders

**Purpose:** PRD fix rule: `null` renders as `"—"`, not `0`. Two V2 spots violate this today:
1. `apps/web/app/_components/freshness-badge.tsx:24-25` — `graph_nodes_written ?? 0`, `graph_edges_written ?? 0`.
2. `apps/web/app/api/devices/list/csv/route.ts:107` — `r.fanout ?? 0`.

**Files:**
- Create: `apps/web/lib/format.ts` — export `formatNullable(v: number | string | null | undefined, dash = "—"): string`. Pure, tested.
- Create: `apps/web/test/format.test.ts` — 4 cases (number, string, null, undefined).
- Modify: `apps/web/app/_components/freshness-badge.tsx` — use `formatNullable(run.graph_nodes_written)` and `formatNullable(run.graph_edges_written)`.
- Modify: `apps/web/app/api/devices/list/csv/route.ts` — for `fanout`: emit empty string (not "0", not "—" — CSV cells for missing numeric data should be empty per common convention). Use `formatNullable(r.fanout, "")`.
- Modify: `apps/web/components/DeviceCard.tsx`, `neighbors-table.tsx`, `PathRibbon.tsx` — optionally standardize on `formatNullable` where patterns already render "—". Only if the change is purely mechanical; skip if risky.
- Modify: `apps/web/test/freshness-badge.test.tsx` (if exists) or add a snapshot assertion in `home-page.test.tsx` (which tests freshness via layout) confirming "—" renders when counts are null.

**Steps:**

1. Write failing tests for `formatNullable`.
2. Implement helper.
3. Replace call sites.
4. Run: `pnpm --filter web test -- --run`. All pass (≥318).
5. Commit: `fix: null-as-null UI contract via formatNullable helper (#59)`.

---

## Task 14: V1 bug regression tests — where V2 code paths exist

**Purpose:** Plant regression guards for the 4 V1 bugs. Two of those depend on code paths V2 doesn't have yet; we only guard the two that DO have V2 code paths.

**Files:**
- Modify: `apps/web/test/format.test.ts` — add `ruleFIX: freshness-badge does not silently zero null counts` (implicit via Task 13).
- Modify: `apps/ingestor/test/ingest.int.test.ts` — add `ruleFIX: NaN-like source values stay null through pipeline` — seed a source row with `vendor_a=null` and assert the Neo4j device.vendor is null (not "0" or ""), and isolations aggregate counts remain correct.
- Explicitly document in `apps/ingestor/test/contract/README.md`:
  - `ruleFIX (deferred to Slice 4): total_offline filter uses status='Offline'` — V2 has no V2 equivalent today; regression guard lands with Slice 4's customer data surfaces if we adopt ClickHouse.
  - `ruleFIX (deferred to Slice 4): NSR suffix stripping is executed` — depends on CID loader, not yet in V2.
  - `ruleFIX (deferred to Slice 4): CID upsert idempotent on re-run` — depends on CID loader.

**Steps:**

1. Add the two regression tests.
2. Update the README documentation.
3. Run tests.
4. Commit: `test: V1 bug regression guards for in-scope code paths (#59)`.

---

## Task 15: Contract README final status update

**Files:**
- Modify: `apps/ingestor/test/contract/README.md` — fill in the file column for every rule; compute final count: rules covered in this PR vs deferred vs N/A.

**Steps:**

1. Update README with actual file paths for each rule test.
2. Commit: `docs: finalize contract README with per-rule test locations (#59)`.

---

## Task 16: Verification + PR

**Step 1: Full suite**

```bash
pnpm -r typecheck
pnpm --filter @tsm/db build    # CLAUDE.md pitfall guard
pnpm --filter ingestor test -- --run
pnpm --filter web test -- --run
pnpm --filter web test:int -- --run
```

All must pass. Fresh runs only.

**Step 2: Contract-rule traversal**

Run `pnpm --filter ingestor test -- --run | grep 'rule'` and confirm every rule prefix (PORT / FIX / REJECT) that this PR claims to cover actually produces a test result line.

**Step 3: Push + PR**

```bash
git push -u origin feat/issue-59-ingest-correctness
gh pr create --title "feat: ingest correctness — 31-rule contract, tags, SW level fix, null-as-null UI (#59)"
```

Body includes the per-rule table from the contract README with status per rule. Explicitly list 6 deferred rules and which later slice owns each.

**Step 4: Monitor CI, merge.**

**Step 5: Phase 7 — update issue with checkbox ticks + completion comment.**

---

## Rules explicitly deferred (for PR body)

| Rule | Why deferred | Target slice |
|---|---|---|
| LD/NSR suffix stripping | Needs CID loader | #61 Slice 4 DWDM |
| `'nan'` protection CID → null | Needs CID loader | #61 Slice 4 DWDM |
| CID upsert semantics | Needs CID loader | #61 Slice 4 DWDM |
| Protection CID space-split → first CID | Needs CID loader | #61 Slice 4 DWDM |
| `UPLINK_EXCLUDE_LIST` in alternate path | Query-layer, belongs with path Cypher rewrite | #60 Slice 3 weighted paths |
| Main-graph weakly-connected-component threshold | Query-layer, belongs with path Cypher rewrite | #60 Slice 3 weighted paths |
| V1 `total_offline` bug fix | V2 has no OLT customer surface | #61 Slice 4 (ClickHouse decision pending) |
| V1 SAI Ping BNG failover | **Rejected by PRD** — stays a no-op | — |

---

## Risks

- **SW leveling test needs a `:SW` device type in the fixture.** Check if lldp-50.ts already seeds one; if not, add one.
- **`tag_map` adds a `tags` property to every device.** Any downstream code that does `MERGE (d:Device)` from outside the ingestor and omits `tags` will wipe it. Grep for stray device MERGEs before landing Task 6.
- **RAN service codes may be sensitive.** If V1's codes look like real operator identifiers, substitute redacted placeholders and flag in the PR body.
- **`status=false` source filter may silently reduce existing test fixture row counts.** Check int-test fixtures for any `status=false` row and update expected counts if needed.
- **Tag array cardinality.** Neo4j indexes on arrays perform worse than scalar indexes; verify `CREATE INDEX device_tags` actually creates a useful index, or adjust to a composite/relationship-based approach if EXPLAIN shows full scan.

---

## Done when

1. All tasks committed on `feat/issue-59-ingest-correctness`.
2. PR green and merged.
3. Issue #59 closed (auto via `Closes #59`).
4. Contract README lists 31 rules with final status (covered / deferred / N/A).
5. PR body acceptance-criteria checkboxes all ticked, including explicit links to the deferred-rule follow-ups in #60 and #61.
