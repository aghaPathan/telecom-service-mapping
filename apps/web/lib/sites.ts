import { z } from "zod";
import { getDriver } from "./neo4j";

export type SiteWithCoords = {
  name: string;
  lat: number;
  lng: number;
  region: string | null;
  category: string | null;
  /** Count of access-tier devices (RAN, PTP, PMP, Customer — level 4+). */
  ran_count: number;
  /** Count of IP-transport devices (level 1..3.5). */
  ip_count: number;
  total: number;
};

export type SiteLayer = "all" | "ran" | "ip";

const NeoRowSchema = z.object({
  name: z.string(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  region: z.string().nullable(),
  category: z.string().nullable(),
  ran_count: z.number().int().nonnegative(),
  ip_count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return 0;
}

export async function readSitesWithCoords(): Promise<SiteWithCoords[]> {
  const session = getDriver().session({ defaultAccessMode: "READ" });
  try {
    const result = await session.run(
      `MATCH (s:Site)
        WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL
       OPTIONAL MATCH (s)<-[:LOCATED_AT]-(d:Device)
       WITH s,
            sum(CASE WHEN d.level >= 4 THEN 1 ELSE 0 END) AS ran_count,
            sum(CASE WHEN d.level IS NOT NULL AND d.level < 4 THEN 1 ELSE 0 END) AS ip_count,
            count(d) AS total
       RETURN s.name AS name, s.lat AS lat, s.lng AS lng,
              s.region AS region, s.category AS category,
              ran_count, ip_count, total
       ORDER BY total DESC, name ASC`,
    );
    return result.records.map((r) =>
      NeoRowSchema.parse({
        name: r.get("name"),
        lat: r.get("lat"),
        lng: r.get("lng"),
        region: r.get("region") ?? null,
        category: r.get("category") ?? null,
        ran_count: toNumber(r.get("ran_count")),
        ip_count: toNumber(r.get("ip_count")),
        total: toNumber(r.get("total")),
      }),
    );
  } finally {
    await session.close();
  }
}

export function filterByLayer(
  sites: readonly SiteWithCoords[],
  layer: SiteLayer,
): SiteWithCoords[] {
  if (layer === "all") return [...sites];
  if (layer === "ran") return sites.filter((s) => s.ran_count > 0);
  return sites.filter((s) => s.ip_count > 0);
}
