import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import pg from "pg";
import { readCidRows } from "../src/source/cid.ts";

const { Client } = pg;
let container: StartedTestContainer;
let connectionUri: string;

beforeAll(async () => {
  container = await new GenericContainer("postgres:13-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(
        /database system is ready to accept connections/,
        2,
      ),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  connectionUri = `postgres://test:test@${host}:${port}/test`;

  const c = new Client({ connectionString: connectionUri });
  await c.connect();
  await c.query(`
    CREATE TABLE public.app_cid (
      cid             text,
      capacity        text,
      source          text,
      dest            text,
      bandwidth       text,
      protection_type text,
      protection_cid  text,
      mobily_cid      text,
      region          text
    );
    INSERT INTO public.app_cid VALUES
      ('CID-001','10G','SRC-A','DST-A','10G','1+1','PCID-001','MCID-001','RIYADH'),
      ('CID-002','100G','SRC-B','DST-B','100G','1+1','nan','MCID-002','JEDDAH'),
      ('CID-003','10G','SRC-C','DST-C','10G','UNPROT','','MCID-003','DAMMAM'),
      (NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  `);
  await c.end();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("readCidRows", () => {
  it("returns 3 rows (filters NULL cid)", async () => {
    const rows = await readCidRows(connectionUri);
    expect(rows).toHaveLength(3);
  });

  it("preserves raw protection_cid string (caller parses)", async () => {
    const rows = await readCidRows(connectionUri);
    const c1 = rows.find((r) => r.cid === "CID-001");
    expect(c1?.protection_cid).toBe("PCID-001");
    const c2 = rows.find((r) => r.cid === "CID-002");
    expect(c2?.protection_cid).toBe("nan");
    const c3 = rows.find((r) => r.cid === "CID-003");
    expect(c3?.protection_cid).toBe("");
  });

  it("maps all columns to RawCidRow shape", async () => {
    const rows = await readCidRows(connectionUri);
    const c1 = rows.find((r) => r.cid === "CID-001");
    expect(c1).toMatchObject({
      cid: "CID-001",
      capacity: "10G",
      source: "SRC-A",
      dest: "DST-A",
      bandwidth: "10G",
      protection_type: "1+1",
      protection_cid: "PCID-001",
      mobily_cid: "MCID-001",
      region: "RIYADH",
    });
  });
});
