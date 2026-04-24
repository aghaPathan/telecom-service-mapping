import { getDriver } from "@/lib/neo4j";
import { getPool } from "@/lib/postgres";

export type HomeKpis = {
  totalDevices: number;
  byVendor: Record<string, number>;
  isolationCount: number;
};

export async function getHomeKpis(): Promise<HomeKpis> {
  const session = getDriver().session();
  const pool = getPool();
  try {
    const [graphRes, pgRes] = await Promise.all([
      session.run(
        `MATCH (d:Device) RETURN d.vendor AS vendor, count(*) AS n`
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM isolations`
      ),
    ]);

    const byVendor: Record<string, number> = {};
    let totalDevices = 0;
    for (const r of graphRes.records) {
      const vendor: string = r.get("vendor") ?? "unknown";
      const raw = r.get("n");
      const n: number = typeof raw === "number" ? raw : raw.toNumber();
      byVendor[vendor] = (byVendor[vendor] ?? 0) + n;
      totalDevices += n;
    }

    const isolationCount = Number(pgRes.rows[0]?.count ?? 0);
    return { totalDevices, byVendor, isolationCount };
  } finally {
    await session.close();
  }
}
