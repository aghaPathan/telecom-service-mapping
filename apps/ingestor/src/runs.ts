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
