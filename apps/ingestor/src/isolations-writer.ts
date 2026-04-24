import pg from "pg";
import type { SourceIsolationRow } from "./source/isolations.js";

// pg is CJS; destructure Pool from the default export (same pattern as index.ts).
const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;

/**
 * Full-refresh writer: TRUNCATE the target `isolations` table and re-INSERT
 * all rows in a single transaction. V1 parity semantics — no incremental merge.
 *
 * SECURITY: never log individual rows — they contain real device names.
 */
export async function writeIsolations(
  pool: PoolType,
  rows: SourceIsolationRow[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE isolations");
    if (rows.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      rows.forEach((r, i) => {
        const off = i * 4;
        placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4})`);
        values.push(r.device_name, r.data_source, r.vendor, r.connected_nodes);
      });
      await client.query(
        `INSERT INTO isolations (device_name, data_source, vendor, connected_nodes)
         VALUES ${placeholders.join(", ")}`,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
