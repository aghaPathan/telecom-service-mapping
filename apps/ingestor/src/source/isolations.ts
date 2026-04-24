import pg from "pg";

const { Client } = pg;

export type SourceIsolationRow = {
  device_name: string;
  data_source: string | null;
  vendor: string | null;
  connected_nodes: string[];
};

/**
 * Parse V1 semicolon-delimited `connected_nodes` string into a string array.
 *
 * Trims each token and drops empty entries. Safe to call with null/empty.
 */
export function parseConnectedNodes(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read isolation records from the source Postgres `app_isolations` table.
 *
 * Short-lived Client — same rationale as readActiveLldpRows and readSites.
 *
 * NEVER log the result — contains real device names.
 */
export async function readIsolations(sourceUrl: string): Promise<SourceIsolationRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      device_name: string;
      data_source: string | null;
      vendor: string | null;
      connected_nodes: string | null;
    }>(
      `SELECT device_name, data_source, vendor, connected_nodes
         FROM app_isolations`,
    );
    return rows.map((r) => ({
      device_name: r.device_name,
      data_source: r.data_source,
      vendor: r.vendor,
      connected_nodes: parseConnectedNodes(r.connected_nodes),
    }));
  } finally {
    await client.end();
  }
}
