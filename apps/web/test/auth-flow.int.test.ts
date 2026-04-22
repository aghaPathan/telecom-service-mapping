import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";
import { hashPassword } from "@/lib/password";
import { authenticateCredentials } from "@/lib/authenticate";

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
}, 120_000);

afterAll(async () => {
  // Close both pools: @tsm/db (used by migrate()) and @/lib/postgres (used by
  // authenticateCredentials + our direct queries) before stopping the container,
  // otherwise idle sockets raise "terminating connection" errors at teardown.
  await closeDbPool();
  await closeWebPool();
  await pg.stop();
});

async function truncateAll() {
  await getPool().query(
    `TRUNCATE users, sessions, verification_token, audit_log RESTART IDENTITY CASCADE`,
  );
}

describe("auth schema", () => {
  beforeEach(async () => {
    await truncateAll();
  });

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

describe("manual session minting + revocation", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // This proves DB sessions are revocable — acceptance criterion #3 on issue #7.
  // We mirror the exact INSERT that issueDbSessionCookie runs (the real function
  // also calls next/headers cookies(), which is unavailable outside a Next req
  // context — so we replicate its SQL directly and assert the row shape).
  it("inserts a sessions row that is then deletable (revocation)", async () => {
    const pool = getPool();
    const hash = await hashPassword("secret12345");
    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1,$2,'operator',true) RETURNING id`,
      ["op@example.com", hash],
    );
    const userId = inserted[0]!.id;

    const sessionToken = randomBytes(32).toString("hex");
    expect(sessionToken).toHaveLength(64);
    const expires = new Date(Date.now() + 60 * 60 * 24 * 30 * 1000);
    await pool.query(
      `INSERT INTO sessions (id, "userId", "sessionToken", expires)
       VALUES (gen_random_uuid()::text, $1, $2, $3)`,
      [userId, sessionToken, expires],
    );

    const found = await pool.query(
      `SELECT "userId", expires FROM sessions WHERE "sessionToken"=$1`,
      [sessionToken],
    );
    expect(found.rowCount).toBe(1);
    expect(found.rows[0].userId).toBe(userId);
    expect(new Date(found.rows[0].expires).getTime()).toBeGreaterThan(Date.now());

    // Revoke.
    await pool.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [sessionToken]);
    const afterDelete = await pool.query(
      `SELECT 1 FROM sessions WHERE "sessionToken"=$1`,
      [sessionToken],
    );
    expect(afterDelete.rowCount).toBe(0);
  });
});

describe("authenticateCredentials", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns no_user when email does not exist", async () => {
    const result = await authenticateCredentials("missing@example.com", "whatever12");
    expect(result.kind).toBe("no_user");
  });

  it("returns inactive when user is disabled", async () => {
    const pool = getPool();
    const hash = await hashPassword("correct-password");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1,$2,'viewer',false) RETURNING id`,
      ["inactive@example.com", hash],
    );
    const result = await authenticateCredentials("inactive@example.com", "correct-password");
    expect(result.kind).toBe("inactive");
    if (result.kind === "inactive") {
      expect(result.userId).toBe(rows[0]!.id);
    }
  });

  it("returns bad_password when password does not match", async () => {
    const pool = getPool();
    const hash = await hashPassword("correct-password");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1,$2,'operator',true) RETURNING id`,
      ["ok@example.com", hash],
    );
    const result = await authenticateCredentials("ok@example.com", "wrong-password");
    expect(result.kind).toBe("bad_password");
    if (result.kind === "bad_password") {
      expect(result.userId).toBe(rows[0]!.id);
    }
  });

  it("returns ok with user when credentials are correct", async () => {
    const pool = getPool();
    const hash = await hashPassword("correct-password");
    await pool.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1,$2,'admin',true)`,
      ["admin@example.com", hash],
    );
    const result = await authenticateCredentials("ADMIN@example.com", "correct-password");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.user.email).toBe("admin@example.com");
      expect(result.user.role).toBe("admin");
      expect(result.user.id).toBeTruthy();
    }
  });

  it("normalizes email case on lookup", async () => {
    const pool = getPool();
    const hash = await hashPassword("correct-password");
    await pool.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1,$2,'viewer',true)`,
      ["mixed@example.com", hash],
    );
    const result = await authenticateCredentials("Mixed@Example.COM", "correct-password");
    expect(result.kind).toBe("ok");
  });

  it("returns invalid_input for non-email strings", async () => {
    const result = await authenticateCredentials("not-an-email", "whatever12");
    expect(result.kind).toBe("invalid_input");
  });

  // TODO(7b): end-to-end coverage of requireRole() with a real Next session
  // context is covered by Playwright tests in batch 7b; skip unit test here.
});
