-- Up Migration
-- Mark runs that were aborted because a prior run was still in-flight.
-- See #6: cron must skip overlap and surface it to ingestion_runs.
ALTER TABLE ingestion_runs
  ADD COLUMN skipped BOOLEAN NOT NULL DEFAULT false;

-- Down Migration
-- ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS skipped;
