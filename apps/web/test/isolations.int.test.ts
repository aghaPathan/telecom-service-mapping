import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";
import { listIsolations, parseIsolationsQuery } from "@/lib/isolations";

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();

  // Seed 3 isolation rows
  await getPool().query(`
    INSERT INTO isolations (device_name, data_source, vendor, connected_nodes, load_dt)
    VALUES
      ('UPE-01', 'test', 'huawei', '{}',        NOW()),
      ('CSG-02', 'test', 'huawei', '{A,B,C}',   NOW()),
      ('MDU-03', 'test', 'nokia',  '{X}',        NOW())
  `);
}, 120_000);

afterAll(async () => {
  await closeDbPool();
  await closeWebPool();
  await pg.stop();
});

describe("listIsolations", () => {
  it("returns all 3 rows with correct neighbor_count", async () => {
    const rows = await listIsolations(parseIsolationsQuery({}));
    expect(rows).toHaveLength(3);
    const counts = rows.map((r) => r.neighbor_count);
    // rows ordered by device_name: CSG-02, MDU-03, UPE-01
    expect(counts).toEqual([3, 1, 0]);
  });

  it("filters by vendor (case-insensitive)", async () => {
    const rows = await listIsolations(parseIsolationsQuery({ vendor: "huawei" }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.vendor === "huawei")).toBe(true);
  });

  it("filters by device name substring", async () => {
    const rows = await listIsolations(parseIsolationsQuery({ device: "CSG" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_name).toBe("CSG-02");
    expect(rows[0]!.neighbor_count).toBe(3);
    expect(rows[0]!.connected_nodes).toEqual(["A", "B", "C"]);
  });

  it("respects limit", async () => {
    const rows = await listIsolations(parseIsolationsQuery({ limit: "2" }));
    expect(rows).toHaveLength(2);
  });
});
