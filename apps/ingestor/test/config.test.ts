import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

// Minimum required env to satisfy the existing schema (non-CH keys).
const baseEnv = {
  DATABASE_URL: "postgres://app:app@localhost:5432/app",
  DATABASE_URL_SOURCE: "postgres://ro:ro@localhost:5432/source",
  NEO4J_URI: "bolt://localhost:7687",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "neo4jpw",
} as const;

describe("loadConfig — ClickHouse block", () => {
  it("returns clickhouse: undefined when CLICKHOUSE_URL is unset", () => {
    const cfg = loadConfig({ ...baseEnv } as unknown as NodeJS.ProcessEnv);
    expect(cfg.clickhouse).toBeUndefined();
  });

  it("returns a fully-defaulted clickhouse block when all four required CH vars are set", () => {
    const cfg = loadConfig({
      ...baseEnv,
      CLICKHOUSE_URL: "http://clickhouse:8123",
      CLICKHOUSE_USER: "default",
      CLICKHOUSE_PASSWORD: "secret",
      CLICKHOUSE_DATABASE: "telemetry",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.clickhouse).toEqual({
      url: "http://clickhouse:8123",
      user: "default",
      password: "secret",
      database: "telemetry",
      isisTable: "isis_cost",
      timeoutMs: 10000,
    });
  });

  it("throws when CLICKHOUSE_URL is set but CLICKHOUSE_USER is missing", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        CLICKHOUSE_URL: "http://clickhouse:8123",
        CLICKHOUSE_PASSWORD: "secret",
        CLICKHOUSE_DATABASE: "lldp_data",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/CLICKHOUSE_USER/);
  });

  it("honours CLICKHOUSE_ISIS_TABLE and CLICKHOUSE_TIMEOUT_MS overrides", () => {
    const cfg = loadConfig({
      ...baseEnv,
      CLICKHOUSE_URL: "http://clickhouse:8123",
      CLICKHOUSE_USER: "default",
      CLICKHOUSE_PASSWORD: "secret",
      CLICKHOUSE_DATABASE: "telemetry",
      CLICKHOUSE_ISIS_TABLE: "isis_cost_v2",
      CLICKHOUSE_TIMEOUT_MS: "25000",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.clickhouse?.isisTable).toBe("isis_cost_v2");
    expect(cfg.clickhouse?.timeoutMs).toBe(25000);
  });
});
