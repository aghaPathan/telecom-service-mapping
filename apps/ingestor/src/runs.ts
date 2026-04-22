import type { Pool } from "pg";

export type FinishPayload =
  | {
      status: "succeeded";
      source_rows_read: number;
      rows_dropped_null_b: number;
      rows_dropped_self_loop: number;
      rows_dropped_anomaly: number;
      graph_nodes_written: number;
      graph_edges_written: number;
      sites_loaded: number;
      services_loaded: number;
      terminate_edges: number;
      located_at_edges: number;
      protected_by_edges: number;
      warnings: unknown[];
    }
  | {
      status: "failed";
      error_text: string;
    };

/**
 * Is any ingestion_runs row currently in status='running'? Used by the cron
 * scheduler to skip a tick when the previous run hasn't finished yet.
 */
export async function hasRunningRun(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ingestion_runs WHERE status = 'running'`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Record a skipped cron tick as a distinct ingestion_runs row so history and
 * the freshness badge can distinguish overlap-skips from real runs. Written
 * as status='succeeded' + skipped=true with zeroed counts.
 */
export async function recordSkip(pool: Pool, reason: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ingestion_runs (
       status, finished_at, skipped, dry_run,
       source_rows_read,
       rows_dropped_null_b, rows_dropped_self_loop, rows_dropped_anomaly,
       graph_nodes_written, graph_edges_written,
       sites_loaded, services_loaded,
       terminate_edges, located_at_edges, protected_by_edges,
       warnings_json
     )
     VALUES ('succeeded', now(), true, false,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             $1::jsonb)
     RETURNING id`,
    [JSON.stringify([{ event: "skipped_overlap", reason }])],
  );
  if (rows.length === 0 || rows[0]?.id === undefined) {
    throw new Error("recordSkip: INSERT ... RETURNING returned no id");
  }
  return rows[0].id;
}

/**
 * Insert a new `ingestion_runs` row in `status='running'`. Returns its id so
 * the caller can close it out with `finishRun` on success/failure.
 */
export async function startRun(
  pool: Pool,
  opts: { dryRun: boolean },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ingestion_runs (status, dry_run)
     VALUES ('running', $1)
     RETURNING id`,
    [opts.dryRun],
  );
  if (rows.length === 0 || rows[0]?.id === undefined) {
    throw new Error("startRun: INSERT ... RETURNING returned no id");
  }
  return rows[0].id;
}

/**
 * Close out a run row. On success, writes counts + warnings. On failure,
 * writes error_text and zeros the counts so the row is still well-formed.
 */
export async function finishRun(
  pool: Pool,
  id: number,
  payload: FinishPayload,
): Promise<void> {
  if (payload.status === "succeeded") {
    await pool.query(
      `UPDATE ingestion_runs
         SET status = 'succeeded',
             finished_at = now(),
             source_rows_read = $2,
             rows_dropped_null_b = $3,
             rows_dropped_self_loop = $4,
             rows_dropped_anomaly = $5,
             graph_nodes_written = $6,
             graph_edges_written = $7,
             sites_loaded = $8,
             services_loaded = $9,
             terminate_edges = $10,
             located_at_edges = $11,
             protected_by_edges = $12,
             warnings_json = $13::jsonb
       WHERE id = $1`,
      [
        id,
        payload.source_rows_read,
        payload.rows_dropped_null_b,
        payload.rows_dropped_self_loop,
        payload.rows_dropped_anomaly,
        payload.graph_nodes_written,
        payload.graph_edges_written,
        payload.sites_loaded,
        payload.services_loaded,
        payload.terminate_edges,
        payload.located_at_edges,
        payload.protected_by_edges,
        JSON.stringify(payload.warnings),
      ],
    );
  } else {
    await pool.query(
      `UPDATE ingestion_runs
         SET status = 'failed',
             finished_at = now(),
             error_text = $2
       WHERE id = $1`,
      [id, payload.error_text],
    );
  }
}
