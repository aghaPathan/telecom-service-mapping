import pg from "pg";
import type { RawLldpRow } from "../dedup.js";

const { Client } = pg;

/**
 * Read currently-active LLDP adjacencies from the source Postgres.
 *
 * Opens a short-lived pg.Client (not a pool): nightly full-refresh doesn't
 * justify keeping a connection around, and the source DB is read-only for us.
 *
 * Only selects `status = true` per PRD: the source has a trigger
 * (`on_insert_deactivate_old_records`) that flips older rows to `status=false`
 * when a newer observation arrives, so this filter is our "currently observed"
 * definition.
 *
 * NEVER log the result — contains real hostnames / IPs / MACs.
 */
export async function readActiveLldpRows(sourceUrl: string): Promise<RawLldpRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawLldpRow>(
      `SELECT
         device_a_name,
         device_a_interface,
         device_a_trunk_name,
         device_a_ip,
         device_a_mac,
         device_b_name,
         device_b_interface,
         device_b_ip,
         device_b_mac,
         vendor_a,
         vendor_b,
         domain_a,
         domain_b,
         type_a,
         type_b,
         COALESCE(updated_at, NOW()) AS updated_at
       FROM app_lldp
       WHERE status = true`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
