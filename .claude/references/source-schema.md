# Source Postgres schema (reference — read before touching the ingestor source stage)

Source DB access is **read-only only** via the `lldp_readonly` role (`default_transaction_read_only=on`). Never grant write.

## `app_lldp` (689k rows, ~221k active)

- **Pair columns:** `device_a_name`, `device_a_interface`, `device_a_trunk_name`, `device_a_ip`, `device_a_mac`, `device_b_name`, `device_b_interface`, `device_b_ip`, `device_b_mac`
- **Classification:** `type_a`, `type_b`, `vendor_a`, `vendor_b`, `domain_a`, `domain_b`
- **Lifecycle:** `status` (boolean — **true means currently observed**, false means deactivated by trigger on later poll), `load_dt`, `created_at`, `updated_at`, `data_source`
- **Triggers of interest:**
  - `on_insert_deactivate_old_records` — explains why we filter `status = true`.
  - `on_insert_lldp_data` — populates `app_devicecid`.

### Known row-shape quirks
- ~90% of rows are one-directional; ~10% are mirrored. Dedup via canonical unordered `{(device, interface)}` pair.
- 33% have blank `type_*` — fall back to name-prefix resolver → `Unknown`.
- 16,507 rows have NULL `device_b_name` — drop, but surface the count in UI.
- 733 links have >2 rows per canonical pair — anomaly; keep latest `updated_at`, log the rest to `ingestion_runs.warnings_json`.

## `app_cid` — customer circuit master

Columns:

- `cid` (PK) — circuit identifier; primary key in V1, becomes the MERGE key on `:CID` nodes in V2 (contract rule #28).
- `capacity` — link capacity (string, free-form).
- `source`, `dest` — A-end / Z-end labels (free-form text; not normalized to device names in V1).
- `bandwidth` — provisioned bandwidth (string).
- `protection_type` — e.g. `1+1`, `unprotected`.
- `protection_cid` — **raw** protection-CID string. V1 stringifies Python NaN to literal `'nan'`; both `'nan'` and empty → null per `parseProtectionCids` (contract rule #20). Multi-CID values are space-separated; V2 parses to a list preserving order (contract rule #21). V1 uses `.split()[0]` (the first element) as the display label. **In V2 this lives on `:CID` nodes as `protection_cids: string[]`, NOT on `:DWDM_LINK` edges** — see [ADR 0005](../../docs/decisions/0005-dwdm-data-model.md).
- `mobily_cid` — operator-internal CID.
- `region` — region code.

## `public.dwdm` — DWDM topology source

Columns (V1-confirmed via `dwdm_view.py:54-60`):

- `device_a_name`, `device_a_interface`, `device_a_ip`
- `device_b_name`, `device_b_interface`, `device_b_ip`
- `"Ring"` — **CamelCase and double-quoted in V1's SQL**; Postgres folds unquoted identifiers to lowercase, so the quotes are load-bearing. Preserve the quoting in V2 readers (the projection in `apps/ingestor/src/source/dwdm.ts` aliases `"Ring" AS ring`).
- `snfn_cids` — space-separated CID list (parsed via `parseCidList`).
- `mobily_cids` — space-separated CID list (parsed via `parseCidList`).
- `span_name` — carries one of two suffixes that must be stripped:
  - ` -  LD` — **two spaces before LD** per V1 (contract rule #19).
  - ` - NSR` — single space (contract rule #27; both branches run independently in V2, fixing V1's unreachable `elif`).

V2 dedups on canonical unordered `{(device_a_name, device_b_name)}` (same rule as LLDP), drops self-loops and NULL `device_*_name`, and keeps the latest row on multi-row anomalies. `protection_cid` is **not** on this table — it's loaded from `app_cid` (above).

## `app_devicecid`

`(cid, device_a_name, device_b_name)` mapping of circuits to device endpoints. Populated by the trigger above.

## `app_sitesportal`

`(site_name, category, site_url)`.

## Out of scope for MVP

`alarms`, `isolations`, `techbuilding`, `span`, `screenportal`. Don't read these in the ingestor.
