-- Up Migration
ALTER TABLE ingestion_runs
  ADD COLUMN sites_loaded         INTEGER,
  ADD COLUMN services_loaded      INTEGER,
  ADD COLUMN terminate_edges      INTEGER,
  ADD COLUMN located_at_edges     INTEGER,
  ADD COLUMN protected_by_edges   INTEGER;

-- Down Migration
-- ALTER TABLE ingestion_runs
--   DROP COLUMN IF EXISTS sites_loaded,
--   DROP COLUMN IF EXISTS services_loaded,
--   DROP COLUMN IF EXISTS terminate_edges,
--   DROP COLUMN IF EXISTS located_at_edges,
--   DROP COLUMN IF EXISTS protected_by_edges;
