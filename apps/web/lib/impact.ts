import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { MAX_DOWNSTREAM_DEPTH } from "@/lib/downstream";

export const HARD_CAP = 10_000;

export const ImpactQuery = z.object({
  device: z.string().trim().min(1).max(200),
  max_depth: z.coerce.number().int().min(1).max(MAX_DOWNSTREAM_DEPTH).default(10),
  include_transport: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
});
export type ImpactQuery = z.infer<typeof ImpactQuery>;

export function parseImpactQuery(input: unknown): ImpactQuery {
  return ImpactQuery.parse(input);
}

export const ImpactRow = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  vendor: z.string().nullable(),
  hops: z.number().int(),
});
export type ImpactRow = z.infer<typeof ImpactRow>;

export const RoleSummary = z.object({
  role: z.string(),
  level: z.number(),
  count: z.number().int(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

export const ImpactResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
    rows: z.array(ImpactRow),
  }),
  z.object({
    status: z.literal("too_large"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
  }),
  z.object({ status: z.literal("start_not_found") }),
]);
export type ImpactResponse = z.infer<typeof ImpactResponse>;

export async function runImpact(
  q: ImpactQuery,
  opts: { hardCap?: number } = {},
): Promise<ImpactResponse> {
  const hardCap = opts.hardCap ?? HARD_CAP;
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const startRes = await session.run(
      `MATCH (d:Device {name:$name})
       RETURN d { .name, .role, .level } AS node`,
      { name: q.device },
    );
    if (startRes.records.length === 0) return { status: "start_not_found" };
    const startNode = startRes.records[0]!.get("node") as Record<string, unknown>;
    const start = {
      name: String(startNode.name),
      role: String(startNode.role ?? "Unknown"),
      level: toNum(startNode.level ?? 0),
    };

    const maxDepth = q.max_depth;
    // Shortest strictly-increasing path per dst, so `hops` is deterministic.
    // The WHERE after DISTINCT keeps MW out of the projection when
    // include_transport is false — matching runDownstream semantics.
    // maxDepth is zod-validated int; safe to interpolate (Neo4j refuses
    // parameters inside variable-length bounds — see runDownstream).
    const rowsRes = await session.run(
      `MATCH p = shortestPath(
         (start:Device {name:$name})-[:CONNECTS_TO*1..${maxDepth}]-(dst:Device)
       )
       WHERE start <> dst
         AND ALL(i IN range(0, length(p)-1)
                 WHERE nodes(p)[i].level < nodes(p)[i+1].level)
       WITH DISTINCT dst, length(p) AS hops
       WHERE $include_transport OR dst.level <> 3.5
       RETURN dst { .name, .role, .level, .site, .vendor } AS node, hops
       ORDER BY hops ASC, dst.level ASC, dst.name ASC`,
      { name: q.device, include_transport: q.include_transport },
    );

    const rows: ImpactRow[] = rowsRes.records.map((rec) => {
      const n = rec.get("node") as Record<string, unknown>;
      return {
        name: String(n.name),
        role: String(n.role ?? "Unknown"),
        level: toNum(n.level ?? 0),
        site: toStrOrNull(n.site),
        vendor: toStrOrNull(n.vendor),
        hops: toNum(rec.get("hops")),
      };
    });

    const byKey = new Map<string, RoleSummary>();
    for (const r of rows) {
      const k = `${r.level} ${r.role}`;
      const existing = byKey.get(k);
      if (existing) existing.count++;
      else byKey.set(k, { role: r.role, level: r.level, count: 1 });
    }
    const summary = [...byKey.values()].sort(
      (a, b) => a.level - b.level || b.count - a.count,
    );
    const total = rows.length;

    if (total > hardCap) {
      return { status: "too_large", start, total, summary };
    }
    return { status: "ok", start, total, summary, rows };
  } finally {
    await session.close();
  }
}

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}
function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
