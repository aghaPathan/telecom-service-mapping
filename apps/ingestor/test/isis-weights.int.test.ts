import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import neo4j, { type Driver } from "neo4j-driver";
import { writeIsisWeights } from "../src/graph/writer.ts";
import type { IsisCostRow } from "../src/source/isis-cost.ts";

describe("writeIsisWeights (testcontainers)", () => {
  let neo4jC: StartedTestContainer;
  let driver: Driver;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  beforeAll(async () => {
    neo4jC = await new GenericContainer("neo4j:5-community")
      .withEnvironment({
        NEO4J_AUTH: `${neoUser}/${neoPassword}`,
      })
      .withExposedPorts(7687, 7474)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .withStartupTimeout(120_000)
      .start();

    const neoUri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
    driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
  }, 180_000);

  afterAll(async () => {
    await driver?.close();
    await neo4jC?.stop();
  }, 60_000);

  async function wipe(): Promise<void> {
    const s = driver.session();
    try {
      await s.run("MATCH (n) DETACH DELETE n");
    } finally {
      await s.close();
    }
  }

  async function seedEdge(
    a: string,
    b: string,
    a_if: string,
    b_if: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const s = driver.session();
    try {
      await s.run(
        `MERGE (x:Device {name: $a})
         MERGE (y:Device {name: $b})
         MERGE (x)-[r:CONNECTS_TO {a_if: $a_if, b_if: $b_if}]->(y)
         SET r += $extra`,
        { a, b, a_if, b_if, extra },
      );
    } finally {
      await s.close();
    }
  }

  async function readEdge(
    a: string,
    b: string,
  ): Promise<{
    weight: number | null;
    weight_source: string | null;
    weight_observed_at: string | null;
  }> {
    const s = driver.session();
    try {
      const r = await s.run(
        `MATCH (:Device {name: $a})-[r:CONNECTS_TO]-(:Device {name: $b})
         RETURN r.weight AS weight, r.weight_source AS source,
                toString(r.weight_observed_at) AS observed_at LIMIT 1`,
        { a, b },
      );
      const rec = r.records[0]!;
      const weight = rec.get("weight");
      return {
        weight:
          weight === null || weight === undefined
            ? null
            : typeof weight === "number"
              ? weight
              : weight.toNumber?.() ?? Number(weight),
        weight_source: rec.get("source") as string | null,
        weight_observed_at: rec.get("observed_at") as string | null,
      };
    } finally {
      await s.close();
    }
  }

  function row(
    a: string,
    b: string,
    if_a: string,
    if_b: string,
    weight: number,
    observed_at = new Date("2026-04-25T10:00:00Z"),
  ): IsisCostRow {
    return {
      device_a_name: a,
      device_a_interface: if_a,
      device_b_name: b,
      device_b_interface: if_b,
      weight,
      observed_at,
    };
  }

  it("matches the edge with reversed orientation and writes weight + source + observed_at", async () => {
    await wipe();
    await seedEdge("A", "B", "Eth1", "Eth2");

    const result = await writeIsisWeights(driver, [
      row("B", "A", "Eth2", "Eth1", 7),
    ]);

    expect(result.edges_matched).toBe(1);
    const edge = await readEdge("A", "B");
    expect(edge.weight).toBe(7);
    expect(edge.weight_source).toBe("observed");
    expect(edge.weight_observed_at).toContain("2026-04-25T10:00:00");
  });

  it("matches the edge with same orientation", async () => {
    await wipe();
    await seedEdge("A", "B", "Eth1", "Eth2");

    const result = await writeIsisWeights(driver, [
      row("A", "B", "Eth1", "Eth2", 5),
    ]);

    expect(result.edges_matched).toBe(1);
    const edge = await readEdge("A", "B");
    expect(edge.weight).toBe(5);
    expect(edge.weight_source).toBe("observed");
  });

  it("preserves existing weight on edges that have no incoming row", async () => {
    await wipe();
    await seedEdge("A", "B", "Eth1", "Eth2", { weight: 99 });
    // unrelated edge that we'll target
    await seedEdge("C", "D", "Eth3", "Eth4");

    const result = await writeIsisWeights(driver, [
      row("C", "D", "Eth3", "Eth4", 3),
    ]);

    expect(result.edges_matched).toBe(1);
    const ab = await readEdge("A", "B");
    expect(ab.weight).toBe(99);
    expect(ab.weight_source).toBeNull();
    expect(ab.weight_observed_at).toBeNull();
  });

  it("empty input is a no-op and does not touch existing edges", async () => {
    await wipe();
    await seedEdge("A", "B", "Eth1", "Eth2", { weight: 42 });

    const result = await writeIsisWeights(driver, []);

    expect(result.edges_matched).toBe(0);
    const ab = await readEdge("A", "B");
    expect(ab.weight).toBe(42);
    expect(ab.weight_source).toBeNull();
  });

  it("returns accurate edges_matched count across mixed matching/non-matching rows", async () => {
    await wipe();
    await seedEdge("A", "B", "Eth1", "Eth2");
    await seedEdge("C", "D", "Eth3", "Eth4");

    const result = await writeIsisWeights(driver, [
      row("A", "B", "Eth1", "Eth2", 1),
      row("C", "D", "Eth3", "Eth4", 2),
      row("X", "Y", "Eth9", "Eth9", 3), // no such edge
    ]);

    expect(result.edges_matched).toBe(2);
  });
});
