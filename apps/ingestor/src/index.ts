import neo4j from "neo4j-driver";
import { log } from "./logger.js";

async function seed(): Promise<void> {
  const uri = requireEnv("NEO4J_URI");
  const user = requireEnv("NEO4J_USER");
  const password = requireEnv("NEO4J_PASSWORD");

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    connectionAcquisitionTimeout: 10_000,
  });

  try {
    await waitForNeo4j(driver);

    const session = driver.session();
    try {
      await session.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE"
      );
      const result = await session.run(
        "MERGE (d:Device {name: $name}) ON CREATE SET d.created_at = timestamp() RETURN d.name AS name",
        { name: "seed-01" }
      );
      log("info", "seed_merged", { name: result.records[0]?.get("name") ?? null });
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    log("error", "env_missing", { name });
    throw new Error(`${name} must be set`);
  }
  return v;
}

async function waitForNeo4j(
  driver: ReturnType<typeof neo4j.driver>,
  attempts = 30,
  delayMs = 2000
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await driver.verifyConnectivity();
      log("info", "neo4j_ready", { attempt: i });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      log("warn", "neo4j_not_ready", {
        attempt: i,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

seed()
  .then(() => log("info", "ingestor_done"))
  .catch((err) => {
    log("error", "ingestor_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
