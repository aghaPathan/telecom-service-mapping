-- Up Migration
--
-- Issue #67: distinguish full ingest runs from ISIS-cost-only refreshes.
-- The cron worker reads `flavor` to pick the right pipeline; default 'full'
-- preserves existing admin "Run now" behavior.

ALTER TABLE ingestion_triggers
  ADD COLUMN flavor TEXT NOT NULL DEFAULT 'full'
    CHECK (flavor IN ('full', 'isis_cost'));

-- Down Migration
-- ALTER TABLE ingestion_triggers DROP COLUMN flavor;
