import pg from "pg";
const { Client } = pg;

/**
 * Raw row shape from `public.dwdm`. Mirror of V1's SELECT in
 * dwdm_view.py:54-60. NO protection_cid, NO status, NO updated_at —
 * those columns do not exist on public.dwdm. protection_cid lives on
 * app_cid (see source/cid.ts).
 */
export type RawDwdmRow = {
  device_a_name: string | null;
  device_a_interface: string | null;
  device_a_ip: string | null;
  device_b_name: string | null;
  device_b_interface: string | null;
  device_b_ip: string | null;
  ring: string | null;          // SQL "Ring" aliased to ring
  snfn_cids: string | null;
  mobily_cids: string | null;
  span_name: string | null;
};

/**
 * Read all `public.dwdm` rows from the source Postgres.
 * NEVER log results — contains real production hostnames per CLAUDE.md
 * data-sensitivity rules.
 */
export async function readDwdmRows(sourceUrl: string): Promise<RawDwdmRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawDwdmRow>(
      `SELECT
         device_a_name,
         device_a_interface,
         device_a_ip,
         device_b_name,
         device_b_interface,
         device_b_ip,
         "Ring" AS ring,
         snfn_cids,
         mobily_cids,
         span_name
       FROM public.dwdm`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
