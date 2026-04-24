import neo4j from "neo4j-driver";
import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { isKnownRole } from "@/lib/role-allowlist";

const CANONICAL_LEVELS = [1, 2, 3, 3.5, 4, 5, 99] as const;
const SORT_COLS = ["name", "role", "level", "site", "vendor", "fanout"] as const;

const clamp = (max: number) =>
  z.coerce.number().int().min(1).transform((n) => Math.min(n, max));

const Base = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: clamp(500).default(50),
  sort: z.enum(SORT_COLS).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const ByRole = Base.extend({
  mode: z.literal("byRole"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role"),
});

const ByLevel = Base.extend({
  mode: z.literal("byLevel"),
  level: z.coerce
    .number()
    .refine(
      (n) => CANONICAL_LEVELS.includes(n as (typeof CANONICAL_LEVELS)[number]),
      "unknown_level",
    ),
});

const ByFanout = Base.extend({
  mode: z.literal("byFanout"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role").optional(),
  limit: clamp(200).default(20),
});

export const DeviceListQuery = z.discriminatedUnion("mode", [
  ByRole,
  ByLevel,
  ByFanout,
]);
export type DeviceListQuery = z.infer<typeof DeviceListQuery>;

export function parseDeviceListQuery(input: unknown): DeviceListQuery {
  return DeviceListQuery.parse(input);
}

export type DeviceListRow = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  vendor: string | null;
  fanout?: number;
};

export type DeviceListResult = {
  rows: DeviceListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export async function runDeviceList(
  q: DeviceListQuery,
): Promise<DeviceListResult> {
  const driver = getDriver();

  if (q.mode === "byFanout") {
    const session = driver.session({ defaultAccessMode: "READ" });
    try {
      const roleClause = q.role ? "WHERE d.role = $role" : "";
      const res = await session.run(
        `MATCH (d:Device) ${roleClause}
         OPTIONAL MATCH (d)-[r:CONNECTS_TO]-()
         WITH d, count(r) AS fanout
         ORDER BY fanout DESC, d.name ASC
         LIMIT $limit
         RETURN d { .name, .role, .level, .site, .vendor } AS node, fanout`,
        { role: q.role, limit: neo4j.int(q.limit) },
      );
      const rows: DeviceListRow[] = res.records.map((rec) => {
        const n = rec.get("node") as Record<string, unknown>;
        return {
          name: String(n.name),
          role: String(n.role ?? "Unknown"),
          level: toNum(n.level ?? 0),
          site: toStrOrNull(n.site),
          vendor: toStrOrNull(n.vendor),
          fanout: toNum(rec.get("fanout")),
        };
      });
      return {
        rows,
        total: rows.length,
        page: 1,
        pageSize: rows.length,
      };
    } finally {
      await session.close();
    }
  }

  const skip = (q.page - 1) * q.pageSize;
  const dir = q.dir === "desc" ? "DESC" : "ASC";
  // `sort` comes from a Zod-enum literal — safe to interpolate. `fanout`
  // only makes sense in byFanout mode; coerce to `name` defensively here.
  const sortCol = q.sort === "fanout" ? "name" : q.sort;

  const filterClause =
    q.mode === "byRole" ? "WHERE d.role = $role" : "WHERE d.level = $level";

  const listParams: Record<string, unknown> = {
    skip: neo4j.int(skip),
    pageSize: neo4j.int(q.pageSize),
  };
  const countParams: Record<string, unknown> = {};
  if (q.mode === "byRole") {
    listParams.role = q.role;
    countParams.role = q.role;
  }
  if (q.mode === "byLevel") {
    listParams.level = q.level;
    countParams.level = q.level;
  }

  // Separate sessions — a Neo4j session cannot execute two queries
  // concurrently. Running them in parallel halves wall-clock time.
  const listSession = driver.session({ defaultAccessMode: "READ" });
  const countSession = driver.session({ defaultAccessMode: "READ" });
  try {
    const [listRes, countRes] = await Promise.all([
      listSession.run(
        `MATCH (d:Device) ${filterClause}
         RETURN d { .name, .role, .level, .site, .vendor } AS node
         ORDER BY d.${sortCol} ${dir}, d.name ASC
         SKIP $skip LIMIT $pageSize`,
        listParams,
      ),
      countSession.run(
        `MATCH (d:Device) ${filterClause} RETURN count(d) AS total`,
        countParams,
      ),
    ]);

    const rows: DeviceListRow[] = listRes.records.map((rec) => {
      const n = rec.get("node") as Record<string, unknown>;
      return {
        name: String(n.name),
        role: String(n.role ?? "Unknown"),
        level: toNum(n.level ?? 0),
        site: toStrOrNull(n.site),
        vendor: toStrOrNull(n.vendor),
      };
    });
    const total = toNum(countRes.records[0]!.get("total"));
    return { rows, total, page: q.page, pageSize: q.pageSize };
  } finally {
    await Promise.all([listSession.close(), countSession.close()]);
  }
}

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") {
    return (v as Nr).toNumber();
  }
  return Number(v);
}

function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
