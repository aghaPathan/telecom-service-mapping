import neo4j from "neo4j-driver";
import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { toNum, toStrOrNull, toBoolOrNull } from "@/lib/neo4j-coerce";

// ---------- Types ----------

export type DeviceDetail = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  vendor: string | null;
  domain: string | null;
};

export type Neighbor = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  local_if: string | null; // interface on the SUBJECT device's side
  remote_if: string | null; // interface on the neighbor's side
  status: boolean | null;
};

export type Circuit = {
  cid: string;
  mobily_cid: string | null;
  role: string;
};

export type NeighborSort = "role" | "level";

// ---------- Input validation ----------

const NameSchema = z.string().trim().min(1).max(200);

const NeighborOptsSchema = z.object({
  page: z.number().int().min(0),
  size: z.number().int().min(1).max(200),
  sortBy: z.enum(["role", "level"]),
});

// ---------- Exports ----------

export async function loadDevice(name: string): Promise<DeviceDetail | null> {
  // Malformed names (empty, >200 chars) resolve as "not found" rather than
  // throwing — lets Next.js route handlers convert the null into a clean 404
  // instead of surfacing an unhandled ZodError as a 500.
  const parsed = NameSchema.safeParse(name);
  if (!parsed.success) return null;
  const validName = parsed.data;
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (d:Device {name: $name})
       RETURN d { .name, .role, .level, .site, .vendor, .domain } AS node`,
      { name: validName },
    );
    if (res.records.length === 0) return null;
    const n = res.records[0]!.get("node") as Record<string, unknown>;
    return {
      name: String(n.name),
      role: String(n.role ?? "Unknown"),
      level: toNum(n.level ?? 0),
      site: toStrOrNull(n.site),
      vendor: toStrOrNull(n.vendor),
      domain: toStrOrNull(n.domain),
    };
  } finally {
    await session.close();
  }
}

export async function loadNeighbors(
  name: string,
  opts: { page: number; size: number; sortBy: NeighborSort },
): Promise<{ rows: Neighbor[]; total: number }> {
  const validName = NameSchema.parse(name);
  const { page, size, sortBy } = NeighborOptsSchema.parse(opts);

  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const totalRes = await session.run(
      `MATCH (d:Device {name: $name})-[:CONNECTS_TO]-(n:Device)
       RETURN count(DISTINCT n) AS total`,
      { name: validName },
    );
    const total = toNum(totalRes.records[0]?.get("total") ?? 0);
    if (total === 0) return { rows: [], total: 0 };

    const skip = page * size;
    const res = await session.run(
      `MATCH (d:Device {name: $name})-[r:CONNECTS_TO]-(n:Device)
       WITH d, n, r,
            CASE WHEN startNode(r) = d THEN r.a_if ELSE r.b_if END AS local_if,
            CASE WHEN startNode(r) = d THEN r.b_if ELSE r.a_if END AS remote_if
       RETURN
         n.name AS name, n.role AS role, n.level AS level, n.site AS site,
         local_if, remote_if, r.status AS status
       ORDER BY
         CASE WHEN $sortBy = 'role'  THEN n.role END ASC,
         CASE WHEN $sortBy = 'level' THEN n.level END ASC,
         n.name ASC
       SKIP $skip LIMIT $size`,
      {
        name: validName,
        sortBy,
        skip: neo4j.int(skip),
        size: neo4j.int(size),
      },
    );

    const rows: Neighbor[] = res.records.map((rec) => ({
      name: String(rec.get("name")),
      role: String(rec.get("role") ?? "Unknown"),
      level: toNum(rec.get("level") ?? 0),
      site: toStrOrNull(rec.get("site")),
      local_if: toStrOrNull(rec.get("local_if")),
      remote_if: toStrOrNull(rec.get("remote_if")),
      status: toBoolOrNull(rec.get("status")),
    }));
    return { rows, total };
  } finally {
    await session.close();
  }
}

export async function loadCircuits(name: string): Promise<Circuit[]> {
  const validName = NameSchema.parse(name);
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (s:Service)-[t:TERMINATES_AT]->(d:Device {name: $name})
       RETURN s.cid AS cid, s.mobily_cid AS mobily_cid, t.role AS role
       ORDER BY s.cid ASC`,
      { name: validName },
    );
    return res.records.map((rec) => ({
      cid: String(rec.get("cid")),
      mobily_cid: toStrOrNull(rec.get("mobily_cid")),
      role: String(rec.get("role") ?? "unknown"),
    }));
  } finally {
    await session.close();
  }
}
