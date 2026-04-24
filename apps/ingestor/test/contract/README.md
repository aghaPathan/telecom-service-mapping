# Ingest Edge-Case Contract

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
| 1 | null `device_b` rows dropped and counted | PORT | covered-in-this-pr | — | Part of LLDP 8-col dedup; T2 adds contract name |
| 2 | self-loop rows dropped and counted | PORT | covered-in-this-pr | — | Same dedup pass; T2 adds contract name |
| 3 | anomaly (>2 rows same canonical key) keeps latest `updated_at` | PORT | covered-in-this-pr | — | Same dedup pass; T2 adds contract name |
| 4 | symmetric (both-direction) pair merged to one canonical link | PORT | covered-in-this-pr | — | V2 canonical pair; T2 adds contract name |
| 5 | first-seen casing wins for device name | PORT | covered-in-this-pr | — | Dedup merge; T2 adds contract name |
| 6 | first-non-null field merge (vendor / domain / ip / mac) | PORT | covered-in-this-pr | — | Dedup merge; T2 adds contract name |
| 7 | single edge per A→B hop (simple DiGraph — no multi-edges) | PORT | covered-in-this-pr | — | Dedup standardises; T2 adds contract name |
| 8 | resolver priority: `type_column` → name token → fallback | PORT | covered-in-this-pr | — | Resolver already tested; T3 adds contract name |
| 9 | `Unknown` bucket for unmapped codes; blank `type_*` falls back to name-token | PORT | covered-in-this-pr | — | Covers V1's 33% blank observation + Unknown contract; T3 adds name |
| 10 | role in `role_codes.yaml` but absent from `hierarchy.yaml` → Unknown (silent fallback) | PORT | covered-in-this-pr | — | T3 adds contract name |
| 11 | name-prefix fallback (back-compat with legacy resolver path) | PORT | covered-in-this-pr | — | T3 adds contract name |
| 12 | `wiconnect` → `wic` vendor alias (config-driven) | PORT | covered-in-this-pr | — | New `vendor_aliases` block in role_codes.yaml; T4 lands test |
| 13 | `tag_map` multi-tech `tags[]` produced for matching devices; `tags: []` default when absent | PORT | covered-in-this-pr | — | New `tag_map` block in hierarchy.yaml; T5 lands test |
| 14 | `status=false` LLDP rows excluded from active topology at source | PORT | covered-in-this-pr | — | Source SELECT WHERE; T7 lands test |
| 15 | unresolved role tokens rolled up to top-N in `warnings_json` | PORT | covered-in-this-pr | — | Data-quality steward rule; T9 lands test |
| 16 | 8-digit numeric node name classified as `BusinessCustomer` | PORT | covered-in-this-pr | — | Regex pre-check in resolver; T10 lands test |
| 17 | RAN service code dictionary resolves 22 known codes | PORT | covered-in-this-pr | — | `config/ran_service_codes.yaml`; T12 lands test |
| 18 | UPE neighbor suppression in topology rendering | PORT | covered-in-this-pr | — | Query/render layer filter; T3 or integration test adds contract name |
| 19 | span name ` -  LD` / ` - NSR` suffix stripping (both branches) | PORT | deferred | — | Needs CID loader — deferred to #61 (Slice 4 DWDM) |
| 20 | protection CID string `'nan'` → null | PORT | deferred | — | Needs CID loader — deferred to #61 (Slice 4 DWDM) |
| 21 | `protection_cid` space-split → first CID for DWDM protection paths | PORT | deferred | — | Needs CID loader — deferred to #61 (Slice 4 DWDM) |
| 22 | `UPLINK_EXCLUDE_LIST` enforcement (RIPR / RGUX / RGUL / RGUF / RUFX / 2G / 3G / 4G / 5G) | PORT | deferred | — | Query-layer; deferred to #60 (Slice 3 weighted paths) |
| 23 | main-graph = largest weakly-connected component threshold (configurable) | PORT | deferred | — | Query-layer (GDS WCC); deferred to #60 (Slice 3 weighted paths) |
| 24 | `topology_devices_view` → `topology_devices_dynamic_view` fallback | PORT | N/A | — | V2 derives inventory from LLDP links; no devices view read today — investigation in T11; reopen if isolation source (Slice 2) needs it |
| 25 | BNG Master/Slave failover | PORT | N/A | — | Only relevant if SAI Ping reconsidered; SAI Ping is PRD-Rejected — stays a no-op in V2 |
| 26 | V1 `total_offline` filter used `status='Online'` — V2 must use `status='Offline'` | FIX | deferred | — | V2 has no OLT customer surface yet — deferred to #61 (Slice 4 / ClickHouse pending) |
| 27 | V1 NSR-suffix `elif` branch was unreachable — V2 must execute both LD and NSR stripping | FIX | deferred | — | Depends on CID loader — deferred to #61 (Slice 4 DWDM) |
| 28 | V1 `CID.objects.create()` had no dedup — V2 must use upsert / MERGE on CID | FIX | deferred | — | Depends on CID loader — deferred to #61 (Slice 4 DWDM) |
| 29 | V1 ClickHouse wrapper silently zeroed `NaN`/empty/`'NIL'` — V2 must not zero nulls | FIX | covered-in-this-pr | — | `formatNullable` helper + freshness-badge + CSV exporter; T13 lands test |
| 30 | V1 `LoginMiddleware` bypassed `/performance`, `/tools`, `/event`, `/api` — V2 keeps middleware strict | REJECT | N/A | — | V2 auth middleware has no bypass; no code path to test; documented only |
| 31 | V1 "alarms = node-is-up" inverted-liveness / SSH-from-web SAI Ping as production feature | REJECT | N/A | — | Two related PRD rejections; V2 treats alarms as alarms; SSH-from-web rejected (redesign as operator CLI outside V2 scope) |

---

## Status key

| Status | Meaning |
|---|---|
| `covered-in-this-pr` | Code exists or is being written in this PR; test lands in T2–T14 |
| `deferred` | Code or contract test deferred to a named later slice |
| `N/A` | Rule has no applicable V2 code path; documented only |

---

## Compliance matrix regeneration

```
pnpm --filter ingestor test -- --run | grep '\brule' | sort
```
