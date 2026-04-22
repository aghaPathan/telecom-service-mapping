import neo4j, { Driver } from "neo4j-driver";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD must be set");
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionLifetime: 60_000,
    connectionAcquisitionTimeout: 10_000,
  });
  return driver;
}

export async function countDevices(): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      "MATCH (d:Device) RETURN count(d) AS n"
    );
    const record = result.records[0];
    if (!record) return 0;
    const n = record.get("n");
    return typeof n === "number" ? n : n.toNumber();
  } finally {
    await session.close();
  }
}

export async function pingNeo4j(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const started = Date.now();
  try {
    const session = getDriver().session();
    try {
      await session.run("RETURN 1 AS ok");
    } finally {
      await session.close();
    }
    return { ok: true, latency_ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
