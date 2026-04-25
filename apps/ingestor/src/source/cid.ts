import pg from "pg";
const { Client } = pg;

/**
 * Raw row shape from public.app_cid (V1 CID model — see
 * ~/Mobily/git/ServiceMapping_Portal/app/models/cids.py).
 * protection_cid is RAW — caller parses via cid-parser.parseProtectionCids
 * to handle 'nan' / empty-string sentinels and space-split semantics
 * (V1 contract rules #20, #21).
 */
export type RawCidRow = {
  cid: string; // primary identifier — filter null
  capacity: string | null;
  source: string | null;
  dest: string | null;
  bandwidth: string | null;
  protection_type: string | null;
  protection_cid: string | null; // raw — V1 stores 'nan' for null
  mobily_cid: string | null;
  region: string | null;
};

/**
 * Read all rows with non-null cid from public.app_cid.
 * NEVER log results — contains real customer circuit IDs per CLAUDE.md.
 */
export async function readCidRows(sourceUrl: string): Promise<RawCidRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawCidRow>(
      `SELECT cid, capacity, source, dest, bandwidth,
              protection_type, protection_cid, mobily_cid, region
         FROM public.app_cid
         WHERE cid IS NOT NULL`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
