import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import neo4j, { type Driver } from "neo4j-driver";

import {
  writeCidNodes,
  type CidProps,
} from "../src/graph/writer.ts";
import { parseProtectionCids } from "../src/cid-parser.ts";
import { cid50 } from "./fixtures/cid-50.ts";

/**
 * Integration test for PR 1 of #61 (D2): MERGE :CID nodes (V1 contract
 * rule #28 — idempotent upsert by `cid`). Uses a real Neo4j 5
 * testcontainer; the helper is exercised directly so we don't need the
 * full LLDP pipeline.
 *
 * SECURITY: fixtures are synthetic XX-* hostnames. Never log row contents.
 */
describe("writeCidNodes (testcontainer Neo4j)", () => {
  let neo4jC: StartedTestContainer;
  let driver: Driver;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  beforeAll(async () => {
    neo4jC = await new GenericContainer("neo4j:5-community")
      .withEnvironment({ NEO4J_AUTH: `${neoUser}/${neoPassword}` })
      .withExposedPorts(7687, 7474)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .withStartupTimeout(120_000)
      .start();

    const uri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
    driver = neo4j.driver(uri, neo4j.auth.basic(neoUser, neoPassword), {
      connectionAcquisitionTimeout: 10_000,
    });
    // Ensure connectivity
    await driver.verifyConnectivity();
    // Constraint mirrors writeGraph's Phase 2 (idempotent in case helper is
    // called outside writeGraph).
    const session = driver.session();
    try {
      await session.run(
        "CREATE CONSTRAINT cid_uniq IF NOT EXISTS FOR (c:CID) REQUIRE c.cid IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );
    } finally {
      await session.close();
    }
  }, 180_000);

  afterAll(async () => {
    await driver?.close();
    await neo4jC?.stop();
  }, 60_000);

  beforeEach(async () => {
    const session = driver.session();
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }
  });

  function asCidProps(): CidProps[] {
    return cid50.map((r) => ({
      cid: r.cid,
      capacity: r.capacity,
      source: r.source,
      dest: r.dest,
      bandwidth: r.bandwidth,
      protection_type: r.protection_type,
      protection_cids: parseProtectionCids(r.protection_cid),
      mobily_cid: r.mobily_cid,
      region: r.region,
    }));
  }

  it(":CID nodes: MERGE-upsert is idempotent (rule #28)", async () => {
    const cids = asCidProps();
    expect(cids).toHaveLength(50);

    // First write
    const n1 = await writeCidNodes(driver, cids);
    expect(n1).toBe(50);

    // Second write with the same input — node count must remain 50.
    const n2 = await writeCidNodes(driver, cids);
    expect(n2).toBe(50);

    const session = driver.session();
    try {
      const r = await session.run("MATCH (c:CID) RETURN count(c) AS n");
      const n = r.records[0]!.get("n").toNumber();
      expect(n).toBe(50);

      // Property check on a known multi-protection row (CID-A13-DUP-M1):
      // protection_cid = "PCID-X01 PCID-Y01" → ["PCID-X01", "PCID-Y01"].
      const props = await session.run(
        `MATCH (c:CID {cid: $cid})
           RETURN c.protection_cids AS p, c.capacity AS cap, c.mobily_cid AS m`,
        { cid: "CID-A13-DUP-M1" },
      );
      const rec = props.records[0]!;
      expect(rec.get("p")).toEqual(["PCID-X01", "PCID-Y01"]);
      expect(rec.get("cap")).toBe("10G");
      expect(rec.get("m")).toBe("MCID-CID-A13-DUP-M1");

      // Property check on a 'nan' row → empty protection_cids array.
      const nanProps = await session.run(
        `MATCH (c:CID {cid: $cid}) RETURN c.protection_cids AS p`,
        { cid: "CID-A24" },
      );
      expect(nanProps.records[0]!.get("p")).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);
});
