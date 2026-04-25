import { getDriver } from "@/lib/neo4j";

export type IsisFreshness = {
  /** Most recent `weight_observed_at` across all weighted edges, or null if none. */
  latestObservedAt: Date | null;
  /** Fraction in [0, 1]: edges with `weight` set ÷ total `:CONNECTS_TO` edges. UI multiplies by 100. */
  coverageFraction: number;
};

/**
 * Read ISIS-cost coverage and recency from Neo4j.
 *
 * Note: We use a directed match `()-[r:CONNECTS_TO]->()` so each undirected
 * canonical edge is counted exactly once. An undirected match would visit
 * each relationship twice in Neo4j 5, inflating both numerator and
 * denominator (the ratio is preserved, but the absolute counts are wrong).
 */
export async function getIsisFreshness(): Promise<IsisFreshness> {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH ()-[r:CONNECTS_TO]->()
      WITH count(r) AS total,
           count(r.weight) AS withWeight,
           max(r.weight_observed_at) AS latest
      RETURN total, withWeight, latest
    `);
    const record = result.records[0];
    if (!record) return { latestObservedAt: null, coverageFraction: 0 };

    const total = toNumber(record.get("total"));
    const withWeight = toNumber(record.get("withWeight"));
    const latestRaw = record.get("latest");

    const coverageFraction = total === 0 ? 0 : withWeight / total;
    const latestObservedAt =
      latestRaw && typeof latestRaw.toString === "function"
        ? new Date(latestRaw.toString())
        : null;

    return { latestObservedAt, coverageFraction };
  } finally {
    await session.close();
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return 0;
}
