-- Up Migration
--
-- Isolations table (issue #58): stores device isolation snapshots ingested
-- from the source database, capturing each device's connected neighbours at
-- load time.

CREATE TABLE IF NOT EXISTS isolations (
  id              SERIAL PRIMARY KEY,
  device_name     TEXT NOT NULL,
  data_source     TEXT,
  vendor          TEXT,
  connected_nodes TEXT[] NOT NULL DEFAULT '{}',
  load_dt         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS isolations_device_name_idx ON isolations (device_name);
CREATE INDEX IF NOT EXISTS isolations_vendor_idx ON isolations (vendor);

-- Down Migration
-- DROP TABLE IF EXISTS isolations;
