import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, getPool, closePool } from "@tsm/db";

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
}, 120_000);

afterAll(async () => {
  await closePool();
  await pg.stop();
});

describe("auth schema", () => {
  it("creates users, sessions, verification_token, audit_log and role enum", async () => {
    const pool = getPool();
    // NOTE: verification_token is singular to match @auth/pg-adapter (see
    //       node_modules/@auth/pg-adapter/index.js — queries `verification_token`).
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('users','sessions','verification_token','audit_log')
      ORDER BY tablename`);
    expect(rows.map((r) => r.tablename)).toEqual([
      "audit_log",
      "sessions",
      "users",
      "verification_token",
    ]);
    const e = await pool.query(
      `SELECT unnest(enum_range(NULL::user_role))::text AS v ORDER BY v`,
    );
    expect(e.rows.map((r) => r.v)).toEqual(["admin", "operator", "viewer"]);
  });

  it("sessions table has adapter-compatible camelCase columns", async () => {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='sessions'
      ORDER BY column_name`);
    const cols = rows.map((r) => r.column_name).sort();
    // Adapter queries "sessionToken" and "userId" with double quotes — case matters.
    expect(cols).toContain("sessionToken");
    expect(cols).toContain("userId");
    expect(cols).toContain("expires");
    expect(cols).toContain("id");
  });
});
