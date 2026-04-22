import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { DeviceRef } from "@/lib/path";

// ---------- Constants ----------

// Cap server-side. Neo4j doesn't allow parameters in variable-length bounds,
// so the int is interpolated after zod validation.
export const MAX_DOWNSTREAM_DEPTH = 15;

// ---------- Input schema ----------

// Accept string form ("true"/"false") as well as booleans because
// URLSearchParams.get returns strings and max_depth will come in as a string too.
export const DownstreamQuery = z.object({
  device: z.string().trim().min(1).max(200),
  max_depth: z
    .coerce.number()
    .int()
    .min(1)
    .max(MAX_DOWNSTREAM_DEPTH)
    .default(10),
  include_transport: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
});
export type DownstreamQuery = z.infer<typeof DownstreamQuery>;

export function parseDownstreamQuery(input: unknown): DownstreamQuery {
  return DownstreamQuery.parse(input);
}

// ---------- Response schema ----------

// Re-export DeviceRef type for convenience. The zod schema for it lives in
// lib/path.ts and we reuse it here to keep the device shape canonical.
export { DeviceRef };

export const Group = z.object({
  level: z.number(),
  role: z.string(),
  count: z.number().int(),
  devices: z.array(DeviceRef),
});
export type Group = z.infer<typeof Group>;

export const DownstreamResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    start: DeviceRef,
    total: z.number().int(),
    groups: z.array(Group),
  }),
  z.object({
    status: z.literal("start_not_found"),
  }),
]);
export type DownstreamResponse = z.infer<typeof DownstreamResponse>;

// ---------- Cypher resolver ----------

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}

function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

function deviceRefFrom(n: Record<string, unknown>): DeviceRef {
  return {
    name: String(n.name),
    role: String(n.role ?? "Unknown"),
    level: toNum(n.level ?? 0),
    site: toStrOrNull(n.site),
    domain: toStrOrNull(n.domain),
  };
}

export async function runDownstream(
  q: DownstreamQuery,
): Promise<DownstreamResponse> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    // 1. Resolve start device. Return early on not-found so the caller can
    //    render a dedicated UI state instead of an empty group list.
    const startRes = await session.run(
      `MATCH (d:Device {name: $name})
       RETURN d { .name, .role, .level, .site, .domain } AS node`,
      { name: q.device },
    );
    if (startRes.records.length === 0) {
      return { status: "start_not_found" };
    }
    const start = deviceRefFrom(
      startRes.records[0]!.get("node") as Record<string, unknown>,
    );

    // 2. Walk CONNECTS_TO variable-length 1..maxDepth, keeping only paths
    //    whose level strictly INCREASES at every hop — "downstream" in the
    //    hierarchy sense (lesser level upstream, greater level downstream).
    //    Strict `<` rejects same-level peers (e.g. CSG<->CSG ring edges) so
    //    we don't traverse them.
    //    MW (level 3.5) filtering happens AFTER `WITH DISTINCT dst` so that
    //    paths still traverse THROUGH MW hops on their way to deeper devices;
    //    with include_transport=false we only hide MW from the final result.
    //    maxDepth is the validated integer from zod — safe to interpolate.
    //    TODO(#10-perf): profile against production graph; <2s p95 target.
    const maxDepth = q.max_depth;
    const groupsRes = await session.run(
      `MATCH p = (start:Device {name:$name})-[:CONNECTS_TO*1..${maxDepth}]-(dst:Device)
       WHERE ALL(i IN range(0, length(p)-1)
                 WHERE nodes(p)[i].level < nodes(p)[i+1].level)
       WITH DISTINCT dst
       WHERE $include_transport OR dst.level <> 3.5
       WITH dst.role AS role, dst.level AS level,
            collect(dst { .name, .role, .level, .site, .domain }) AS devices
       RETURN role, level, devices, size(devices) AS count
       ORDER BY level ASC, count DESC`,
      { name: q.device, include_transport: q.include_transport },
    );

    const groups: Group[] = groupsRes.records.map((rec) => {
      const devices = (
        rec.get("devices") as Array<Record<string, unknown>>
      ).map(deviceRefFrom);
      return {
        level: toNum(rec.get("level")),
        role: String(rec.get("role") ?? "Unknown"),
        count: toNum(rec.get("count")),
        devices,
      };
    });

    const total = groups.reduce((s, g) => s + g.count, 0);
    return { status: "ok", start, total, groups };
  } finally {
    await session.close();
  }
}
