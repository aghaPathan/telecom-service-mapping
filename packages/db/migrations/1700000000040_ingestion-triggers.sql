-- Up Migration
--
-- Ingestion triggers table (issue #62): queues on-demand ingest requests from
-- admins in the web UI. The ingestor worker claims unclaimed rows, runs the
-- ingest, and links the resulting run_id back to the trigger row.

CREATE TABLE ingestion_triggers (
  id            BIGSERIAL PRIMARY KEY,
  requested_by  UUID NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at    TIMESTAMPTZ,
  run_id        BIGINT REFERENCES ingestion_runs(id)
);

CREATE INDEX ingestion_triggers_unclaimed_idx
  ON ingestion_triggers (requested_at)
  WHERE claimed_at IS NULL;

-- Down Migration
-- DROP TABLE IF EXISTS ingestion_triggers;
