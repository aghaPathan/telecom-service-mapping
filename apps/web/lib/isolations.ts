import { z } from "zod";
import { getPool } from "@/lib/postgres";

export type IsolationRow = {
  device_name: string;
  data_source: string | null;
  vendor: string | null;
  connected_nodes: string[];
  neighbor_count: number;
  load_dt: Date;
};

const Query = z.object({
  vendor: z.string().trim().max(64).optional(),
  device: z.string().trim().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .catch(100)
    .transform((v) => Math.min(Math.max(v, 1), 1000))
    .default(100),
});
export type IsolationsQuery = z.infer<typeof Query>;

export function parseIsolationsQuery(
  input: Record<string, unknown>,
): IsolationsQuery {
  return Query.parse(input);
}

export async function listIsolations(
  q: IsolationsQuery,
): Promise<IsolationRow[]> {
  const pool = getPool();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.vendor) {
    params.push(q.vendor);
    clauses.push(`vendor ILIKE $${params.length}`);
  }
  if (q.device) {
    params.push(`%${q.device}%`);
    clauses.push(`device_name ILIKE $${params.length}`);
  }
  params.push(q.limit);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT device_name, data_source, vendor, connected_nodes, load_dt
               FROM isolations
               ${where}
               ORDER BY device_name
               LIMIT $${params.length}`;

  const res = await pool.query(sql, params);
  return res.rows.map((r) => ({
    ...r,
    neighbor_count: Array.isArray(r.connected_nodes)
      ? r.connected_nodes.length
      : 0,
  }));
}
