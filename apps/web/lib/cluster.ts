import { z } from "zod";
import { getDriver } from "@/lib/neo4j";

// Threshold above which a site's UPEs auto-collapse into a single cluster node
// in the topology view. Matches v1's datacenter-cloud collapse behavior
// (helper_models/Topo.py:637-691). "More than 3" — strict `>` not `>=`.
export const CLUSTER_THRESHOLD = 3;

export const UPE_ROLE = "UPE";

export const ClusterDevice = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  vendor: z.string().nullable(),
});
export type ClusterDevice = z.infer<typeof ClusterDevice>;

export type UpeCluster = {
  site: string;
  count: number;
  nodes: ClusterDevice[];
};

export type ClusterSite = {
  site: string;
  core: ClusterDevice[];
  upes: ClusterDevice[];
  upeCluster: UpeCluster | null;
  csgs: ClusterDevice[];
  transport: ClusterDevice[];
};

/** Parse the `cluster` URL query param. "1" forces clustering on, "0" off;
 *  any other value (including unset) returns `null` meaning "auto" — the
 *  caller applies `shouldCluster(count, null)`. */
export function parseClusterParam(
  v: string | null | undefined,
): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

/** Auto rule: cluster when UPE count STRICTLY exceeds threshold. Explicit
 *  override (true/false) always wins over the auto rule. */
export function shouldCluster(
  upeCount: number,
  override: boolean | null,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  return upeCount > CLUSTER_THRESHOLD;
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

function deviceFrom(n: Record<string, unknown>): ClusterDevice {
  return {
    name: String(n.name),
    role: String(n.role ?? "Unknown"),
    level: toNum(n.level ?? 0),
    site: toStrOrNull(n.site),
    vendor: toStrOrNull(n.vendor),
  };
}

export type RunClusterArgs = {
  site: string;
  /** URL override: `true` force-on, `false` force-off, `null` = auto. */
  clusterUpes?: boolean | null;
};

/**
 * Query every :Device at `site` and bucket by role/level. When `shouldCluster`
 * resolves to true for the site's UPE count, `upeCluster` is populated and
 * `upes` is an empty array — so renderers can handle exactly one branch.
 *
 * Role filtering is by hierarchy `level` (not label), matching the rest of
 * the codebase — labels are config-driven and therefore unreliable for
 * cross-deployment queries.
 */
export async function runCluster({
  site,
  clusterUpes = null,
}: RunClusterArgs): Promise<ClusterSite> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (d:Device {site: $site})
       RETURN d { .name, .role, .level, .site, .vendor } AS node`,
      { site },
    );
    const devices = res.records.map((r) =>
      deviceFrom(r.get("node") as Record<string, unknown>),
    );

    const core: ClusterDevice[] = [];
    const upesRaw: ClusterDevice[] = [];
    const csgs: ClusterDevice[] = [];
    const transport: ClusterDevice[] = [];
    for (const d of devices) {
      if (d.level === 1) core.push(d);
      else if (d.level === 2 && d.role === UPE_ROLE) upesRaw.push(d);
      else if (d.level === 3) csgs.push(d);
      else if (d.level === 3.5) transport.push(d);
    }

    const clustered = shouldCluster(upesRaw.length, clusterUpes);
    const upeCluster: UpeCluster | null = clustered
      ? { site, count: upesRaw.length, nodes: upesRaw }
      : null;
    const upes = clustered ? [] : upesRaw;

    return { site, core, upes, upeCluster, csgs, transport };
  } finally {
    await session.close();
  }
}
