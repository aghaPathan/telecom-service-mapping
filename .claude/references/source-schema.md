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

Columns: `cid`, `source`, `dest`, `bandwidth`, `protection_type`, `protection_cid`, `mobily_cid`, `region`.

## `app_devicecid`

`(cid, device_a_name, device_b_name)` mapping of circuits to device endpoints. Populated by the trigger above.

## `app_sitesportal`

`(site_name, category, site_url)`.

## Out of scope for MVP

`alarms`, `isolations`, `techbuilding`, `span`, `screenportal`. Don't read these in the ingestor.
