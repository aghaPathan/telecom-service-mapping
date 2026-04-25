import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { readDwdmRows } from "../src/source/dwdm.ts";

const { Client } = pg;

describe("readDwdmRows", () => {
  let sourcePg: StartedTestContainer;
  let sourceUrl: string;

  beforeAll(async () => {
    sourcePg = await new GenericContainer("postgres:13-alpine")
      .withEnvironment({
        POSTGRES_USER: "source",
        POSTGRES_PASSWORD: "source",
        POSTGRES_DB: "source",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .start();
    sourceUrl = `postgres://source:source@${sourcePg.getHost()}:${sourcePg.getMappedPort(5432)}/source`;

    const c = new Client({ connectionString: sourceUrl });
    await c.connect();
    try {
      await c.query(`
        CREATE TABLE public.dwdm (
          device_a_name      text,
          device_a_interface text,
          device_a_ip        text,
          device_b_name      text,
          device_b_interface text,
          device_b_ip        text,
          "Ring"             text,
          snfn_cids          text,
          mobily_cids        text,
          span_name          text
        );
        INSERT INTO public.dwdm VALUES
          ('XX-AAA-DWDM-01','OTU1','10.0.0.1','XX-BBB-DWDM-01','OTU1','10.0.0.2','RING-1','S1 S2','M1','XX-AAA - XX-BBB -  LD'),
          ('XX-CCC-DWDM-01','OTU2','10.0.0.3','XX-DDD-DWDM-01','OTU2','10.0.0.4','RING-2','S3','M2 M3','XX-CCC - XX-DDD - NSR'),
          ('XX-EEE-DWDM-01','OTU3',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
      `);
    } finally {
      await c.end();
    }
  }, 180_000);

  afterAll(async () => {
    await sourcePg?.stop();
  });

  it("reads all public.dwdm rows mapping quoted Ring → ring", async () => {
    const rows = await readDwdmRows(sourceUrl);
    expect(rows).toHaveLength(3);
  });

  it("maps columns to RawDwdmRow shape", async () => {
    const rows = await readDwdmRows(sourceUrl);
    const aaa = rows.find((r) => r.device_a_name === "XX-AAA-DWDM-01");
    expect(aaa).toBeDefined();
    expect(aaa).toMatchObject({
      device_a_name: "XX-AAA-DWDM-01",
      device_a_interface: "OTU1",
      device_a_ip: "10.0.0.1",
      device_b_name: "XX-BBB-DWDM-01",
      device_b_interface: "OTU1",
      device_b_ip: "10.0.0.2",
      ring: "RING-1",
      snfn_cids: "S1 S2",
      mobily_cids: "M1",
      span_name: "XX-AAA - XX-BBB -  LD",
    });
  });

  it("preserves NULL columns as null in TypeScript", async () => {
    const rows = await readDwdmRows(sourceUrl);
    const eee = rows.find((r) => r.device_a_name === "XX-EEE-DWDM-01");
    expect(eee?.device_b_name).toBeNull();
    expect(eee?.ring).toBeNull();
  });
});
