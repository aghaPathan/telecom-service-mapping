import pg from "pg";

const { Client } = pg;

export type RawServiceRow = {
  cid: string;
  source: string | null;
  dest: string | null;
  bandwidth: string | null;
  protection_type: string | null;
  protection_cid: string | null;
  mobily_cid: string | null;
  region: string | null;
};

export type RawDeviceCidRow = {
  cid: string;
  device_a_name: string | null;
  device_b_name: string | null;
};

/**
 * Read the service + device-cid tables from the source Postgres in one
 * short-lived client. Rows with NULL `cid` are skipped — `cid` is the join
 * key.
 *
 * NEVER log the result — contains real circuit IDs (including mobily_cid).
 */
export async function readServices(
  sourceUrl: string,
): Promise<{ services: RawServiceRow[]; deviceCids: RawDeviceCidRow[] }> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows: services } = await client.query<RawServiceRow>(
      `SELECT cid, source, dest, bandwidth, protection_type,
              protection_cid, mobily_cid, region
         FROM app_cid
        WHERE cid IS NOT NULL`,
    );
    const { rows: deviceCids } = await client.query<RawDeviceCidRow>(
      `SELECT cid, device_a_name, device_b_name
         FROM app_devicecid
        WHERE cid IS NOT NULL`,
    );
    return { services, deviceCids };
  } finally {
    await client.end();
  }
}
