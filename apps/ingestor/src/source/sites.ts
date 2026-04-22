import pg from "pg";

const { Client } = pg;

export type RawSiteRow = {
  site_name: string;
  category: string | null;
  site_url: string | null;
};

/**
 * Read `app_sitesportal` rows from the source Postgres.
 *
 * Rows with NULL `site_name` are skipped at query time — `name` is the join
 * key for :Site and must be present. Short-lived client, same rationale as
 * readActiveLldpRows.
 *
 * NEVER log the result — contains real site codes.
 */
export async function readSites(sourceUrl: string): Promise<RawSiteRow[]> {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query<RawSiteRow>(
      `SELECT site_name, category, site_url
         FROM app_sitesportal
        WHERE site_name IS NOT NULL`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
