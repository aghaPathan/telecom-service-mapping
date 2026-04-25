# Ingest Edge-Case Contract

Last updated: 2026-04-25 (issue #61, slice 4)

This directory holds contract tests for the 31 V1 ingest-behavior rules that V2 must either replicate, correct, or deliberately reject. Every contract test title begins with a `rule[PORT|FIX|REJECT]:` prefix so a single grep produces a compliance matrix. Run the suite with `pnpm --filter ingestor test -- --run | grep 'rule[A-Z]'` to see which rules pass, which are pending, and whether any rule has silently lost coverage across refactors. Tests that cover rules deferred to later slices are not yet written; their rows use `—` in the Test file column. Later tasks (T2–T14) land the tests; Task 15 fills in the file column.

## Convention

| Prefix | Meaning |
|---|---|
| `rulePORT:` | V1 behavior V2 must replicate |
| `ruleFIX:` | V1 bug V2 corrects (regression guard) |
| `ruleREJECT:` | V1 behavior explicitly NOT ported (documented only) |

## Compliance matrix

```
pnpm --filter ingestor test -- --run | grep '\brule' | sort
```

---

## Rule table

| # | Rule | Type | Status | Test file | Notes |
|---|---|---|---|---|---|
| 1 | null `device_b` rows dropped and counted | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: null device_b rows dropped and counted` |
| 2 | self-loop rows dropped and counted | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: self-loop rows dropped and counted` |
| 3 | anomaly (>2 rows same canonical key) keeps latest `updated_at` | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: anomaly …` |
| 4 | symmetric (both-direction) pair merged to one canonical link | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: symmetric …` |
| 5 | first-seen casing wins for device name | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: first-seen casing wins` |
| 6 | first-non-null field merge (vendor / domain / ip / mac) | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: first-non-null field merge` |
| 7 | single edge per A→B hop (simple DiGraph — no multi-edges) | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T2 added `rulePORT: single edge per A→B hop` |
| 8 | resolver priority: `type_column` → name token → fallback | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T3 added `rulePORT: priority type_column beats name_token` |
| 9 | `Unknown` bucket for unmapped codes; blank `type_*` falls back to name-token | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T3 added `rulePORT: fallback to Unknown …` + `rulePORT: blank type_* falls back to name_token` |
| 10 | role in `role_codes.yaml` but absent from `hierarchy.yaml` → Unknown (silent fallback) | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T3 added `rulePORT: role present in role_codes but missing from hierarchy → Unknown` |
| 11 | name-prefix fallback (back-compat with legacy resolver path) | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T3 added `rulePORT: priority name_token used when type_column is blank` |
| 12 | `wiconnect` → `wic` vendor alias (config-driven) | PORT | covered-in-this-pr | `apps/ingestor/test/dedup.test.ts` | T4 added `rulePORT: wiconnect → wic vendor alias` |
| 13 | `tag_map` multi-tech `tags[]` produced for matching devices; `tags: []` default when absent | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T5 added `rulePORT: tag_map produces tags[]` + `rulePORT: device with no matching tag_map entry has tags: []` |
| 14 | `status=false` LLDP rows excluded from active topology at source | PORT | covered-in-this-pr | `apps/ingestor/test/lldp-source.int.test.ts` | T7 added `rulePORT: status=false rows excluded at source` |
| 15 | unresolved role tokens rolled up to top-N in `warnings_json` | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T9 added `rulePORT: unresolved tokens rolled up to top-N` |
| 16 | 8-digit numeric node name classified as `BusinessCustomer` | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T10 added `rulePORT: 8-digit numeric node classified as BusinessCustomer` |
| 17 | RAN service code dictionary resolves 22 known codes | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts` | T12 added `rulePORT: RAN service code dictionary resolves known codes` |
| 18 | UPE neighbor suppression in topology rendering | PORT | covered-in-this-pr | `apps/ingestor/test/resolver.test.ts`, `apps/ingestor/test/ingest.int.test.ts` | UPE role resolution covered in T3 (resolver); UPE devices written + labeled in integration test; render-layer clustering in `apps/web/test/cluster.test.ts` |
| 19 | span name ` -  LD` / ` - NSR` suffix stripping (both branches) | PORT | landed | `apps/ingestor/test/cid-parser.unit.test.ts` | `stripSpanSuffix` describe-block (rules #19, #27); tests "strips ' -  LD' suffix" and "strips both branches independently". NOTE: tests use `rule #N` markers in describe/it strings, not the `rulePORT:` prefix — they don't show in the `\brule` compliance grep. |
| 20 | protection CID string `'nan'` → null | PORT | landed | `apps/ingestor/test/cid-parser.unit.test.ts` | `parseProtectionCids` describe-block; test "rule #20: 'nan' → []". Same prefix caveat as #19. |
| 21 | `protection_cid` space-split → first CID for DWDM protection paths | PORT | landed | `apps/ingestor/test/cid-parser.unit.test.ts` | `parseProtectionCids` describe-block; test "rule #21: space-split preserving order, first element is V1's protection CID". V2 stores the full list; callers index `[0]`. Same prefix caveat as #19. |
| 22 | `UPLINK_EXCLUDE_LIST` enforcement (RIPR / RGUX / RGUL / RGUF / RUFX / 2G / 3G / 4G / 5G) | PORT | deferred | — | Query-layer; deferred to #60 (Slice 3 weighted paths) |
| 23 | main-graph = largest weakly-connected component threshold (configurable) | PORT | deferred | — | Query-layer (GDS WCC); deferred to #60 (Slice 3 weighted paths) |
| 24 | `topology_devices_view` → `topology_devices_dynamic_view` fallback | PORT | N/A (current architecture) | — | V2 derives device inventory from app_lldp; no devices-view read stage exists. Follow-up: if an inventory-source stage is added later (e.g. for PRD isolations expansion), wire the static→dynamic fallback then. |
| 25 | BNG Master/Slave failover | PORT | N/A | — | Only relevant if SAI Ping reconsidered; SAI Ping is PRD-Rejected — stays a no-op in V2 |
| 26 | V1 `total_offline` filter used `status='Online'` — V2 must use `status='Offline'` | FIX | deferred | — | V2 has no OLT customer surface yet — deferred to #61 (Slice 4 / ClickHouse pending) |
| 27 | V1 NSR-suffix `elif` branch was unreachable — V2 must execute both LD and NSR stripping | FIX | landed | `apps/ingestor/test/cid-parser.unit.test.ts` | `stripSpanSuffix` describe-block (rules #19, #27); tests "strips ' - NSR' suffix (rule #27 — V1 elif was unreachable)" and "strips both branches independently". Prefix caveat as #19. |
| 28 | V1 `CID.objects.create()` had no dedup — V2 must use upsert / MERGE on CID | FIX | landed | `apps/ingestor/test/dwdm-cid.int.test.ts` | Test ":CID nodes: MERGE-upsert is idempotent (rule #28)" against testcontainer Neo4j; second ingest of same input yields same node count. Prefix caveat as #19. |
| 29 | V1 ClickHouse wrapper silently zeroed `NaN`/empty/`'NIL'` — V2 must not zero nulls | FIX | covered-in-this-pr | `apps/web/test/format.test.ts`, `apps/ingestor/test/ingest.int.test.ts` | `formatNullable` helper (T13) covers UI null→dash; regression guard (T14) confirms null vendor stays null in Neo4j |
| 30 | V1 `LoginMiddleware` bypassed `/performance`, `/tools`, `/event`, `/api` — V2 keeps middleware strict | REJECT | N/A | — | V2 auth middleware has no bypass; no code path to test; documented only |
| 31 | V1 "alarms = node-is-up" inverted-liveness / SSH-from-web SAI Ping as production feature | REJECT | N/A | — | Two related PRD rejections; V2 treats alarms as alarms; SSH-from-web rejected (redesign as operator CLI outside V2 scope) |

---

**Landed across PRs (≤ #61 slice 4): 24 rules (1–18, 19–21, 27–29). Deferred: 3 (rules 22–23, 26 — see table). N/A: 4 (rules 24, 25, 30, 31). Total: 31.**

---

## Status key

| Status | Meaning |
|---|---|
| `covered-in-this-pr` | Code exists or is being written in this PR; test lands in T2–T14 |
| `landed` | Code + test exist on `main` (or about to merge in the current PR); cited test file row holds the assertion |
| `deferred` | Code or contract test deferred to a named later slice |
| `N/A` | Rule has no applicable V2 code path; documented only |

---

## Compliance matrix regeneration

```
pnpm --filter ingestor test -- --run | grep '\brule' | sort
```
