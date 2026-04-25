import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createClient } from "@clickhouse/client";
import { readIsisCost, type IsisCostConfig } from "../src/source/isis-cost.ts";

describe("readIsisCost", () => {
  let ch: StartedTestContainer;
  let cfg: IsisCostConfig;

  beforeAll(async () => {
    ch = await new GenericContainer("clickhouse/clickhouse-server:22.3")
      .withExposedPorts(8123, 9000)
      .withEnvironment({
        CLICKHOUSE_DB: "default",
        CLICKHOUSE_USER: "default",
        CLICKHOUSE_PASSWORD: "",
      })
      .withWaitStrategy(Wait.forHttp("/ping", 8123).forStatusCode(200))
      .withStartupTimeout(180_000)
      .start();

    cfg = {
      url: `http://${ch.getHost()}:${ch.getMappedPort(8123)}`,
      user: "default",
      password: "",
      database: "lldp_data",
      isisTable: "isis_cost",
      timeoutMs: 30_000,
    };

    const client = createClient({
      url: cfg.url,
      username: cfg.user,
      password: cfg.password,
      request_timeout: cfg.timeoutMs,
    });
    try {
      await client.command({ query: "CREATE DATABASE IF NOT EXISTS lldp_data" });
      await client.command({
        query: `
          CREATE TABLE lldp_data.isis_cost (
            Device_A_Name      Nullable(String),
            Device_A_Interface Nullable(String),
            ISIS_COST          Int64,
            Device_B_Name      Nullable(String),
            Device_B_Interface Nullable(String),
            Vendor             String,
            RecordDateTime     DateTime
          ) ENGINE = MergeTree()
            ORDER BY (RecordDateTime)
        `,
      });
      await client.insert({
        table: "lldp_data.isis_cost",
        format: "JSONEachRow",
        values: [
          // Pair 1 — three timestamps, argMax should pick weight 12 / 2025-02-14
          { Device_A_Name: "DEV-A", Device_A_Interface: "Eth1", ISIS_COST: 10, Device_B_Name: "DEV-B", Device_B_Interface: "Eth2", Vendor: "Huawei", RecordDateTime: "2025-02-01 00:00:00" },
          { Device_A_Name: "DEV-A", Device_A_Interface: "Eth1", ISIS_COST: 11, Device_B_Name: "DEV-B", Device_B_Interface: "Eth2", Vendor: "Huawei", RecordDateTime: "2025-02-10 00:00:00" },
          { Device_A_Name: "DEV-A", Device_A_Interface: "Eth1", ISIS_COST: 12, Device_B_Name: "DEV-B", Device_B_Interface: "Eth2", Vendor: "Huawei", RecordDateTime: "2025-02-14 00:00:00" },
          // Pair 2 — single sample
          { Device_A_Name: "DEV-C", Device_A_Interface: "Eth3", ISIS_COST: 5, Device_B_Name: "DEV-D", Device_B_Interface: "Eth4", Vendor: "Huawei", RecordDateTime: "2025-01-15 00:00:00" },
          // Self-loop — must be dropped by SQL
          { Device_A_Name: "DEV-A", Device_A_Interface: "Eth1", ISIS_COST: 99, Device_B_Name: "DEV-A", Device_B_Interface: "Eth1", Vendor: "Huawei", RecordDateTime: "2025-02-14 00:00:00" },
          // NULL Device_B_Name — must be dropped by SQL
          { Device_A_Name: "DEV-X", Device_A_Interface: "Eth9", ISIS_COST: 7, Device_B_Name: null, Device_B_Interface: "Eth9", Vendor: "Huawei", RecordDateTime: "2025-02-14 00:00:00" },
        ],
      });
    } finally {
      await client.close();
    }
  }, 240_000);

  afterAll(async () => {
    await ch?.stop();
  });

  it("returns one row per ordered quadruple, dropping NULL pairs and self-loops", async () => {
    const rows = await readIsisCost(cfg);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.device_a_name === "DEV-A" && r.device_b_name === "DEV-A")).toBeUndefined();
    expect(rows.find((r) => r.device_a_name === "DEV-X")).toBeUndefined();
  });

  it("uses argMax(ISIS_COST, RecordDateTime) per pair", async () => {
    const rows = await readIsisCost(cfg);
    const pair1 = rows.find(
      (r) =>
        r.device_a_name === "DEV-A" &&
        r.device_a_interface === "Eth1" &&
        r.device_b_name === "DEV-B" &&
        r.device_b_interface === "Eth2",
    );
    expect(pair1).toBeDefined();
    expect(pair1!.weight).toBe(12);
    expect(pair1!.observed_at.toISOString()).toBe("2025-02-14T00:00:00.000Z");
  });

  it("returns the single-sample pair untouched", async () => {
    const rows = await readIsisCost(cfg);
    const pair2 = rows.find(
      (r) => r.device_a_name === "DEV-C" && r.device_b_name === "DEV-D",
    );
    expect(pair2).toBeDefined();
    expect(pair2!.weight).toBe(5);
    expect(pair2!.observed_at.toISOString()).toBe("2025-01-15T00:00:00.000Z");
  });
});
