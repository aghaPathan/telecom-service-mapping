-- Up Migration
CREATE TYPE ingestion_status AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE ingestion_runs (
  id                     SERIAL PRIMARY KEY,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ,
  status                 ingestion_status NOT NULL DEFAULT 'running',
  source_rows_read       INTEGER,
  rows_dropped_null_b    INTEGER,
  rows_dropped_self_loop INTEGER,
  rows_dropped_anomaly   INTEGER,
  graph_nodes_written    INTEGER,
  graph_edges_written    INTEGER,
  warnings_json          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_text             TEXT,
  dry_run                BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX ingestion_runs_started_at_idx ON ingestion_runs (started_at DESC);

-- Down Migration
-- DROP INDEX IF EXISTS ingestion_runs_started_at_idx;
-- DROP TABLE IF EXISTS ingestion_runs;
-- DROP TYPE IF EXISTS ingestion_status;
