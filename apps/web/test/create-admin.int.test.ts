import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, getPool as getDbPool, closePool } from "@tsm/db";
import { spawn } from "node:child_process";
import path from "node:path";
import { verifyPassword } from "@/lib/password";

let pg: StartedPostgreSqlContainer;
let dbUrl: string;

const webDir = path.resolve(__dirname, "..");
const tsxBin = path.join(webDir, "node_modules", ".bin", "tsx");
const cliPath = path.join(webDir, "scripts", "create-admin.ts");

function runCli(
  stdinInput: string,
  extraArgs: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliPath, ...extraArgs], {
      cwd: webDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) =>
      resolve({ code: code ?? 0, stdout, stderr }),
    );
    child.on("error", reject);
    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  dbUrl = pg.getConnectionUri();
  process.env.DATABASE_URL = dbUrl;
  await migrate();
}, 120_000);

afterAll(async () => {
  await closePool();
  await pg.stop();
});

beforeEach(async () => {
  const pool = getDbPool();
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

describe("create-admin CLI", () => {
  it("creates a new admin user (exit 0) and stores a verifiable bcrypt hash", async () => {
    const email = "new@example.com";
    const password = "hunter2hunter";
    const res = await runCli(`${email}\n${password}\n${password}\n`);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`created admin: ${email}`);

    const pool = getDbPool();
    const { rows } = await pool.query(
      "SELECT email, role, is_active, password_hash FROM users WHERE email=$1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(email);
    expect(rows[0].role).toBe("admin");
    expect(rows[0].is_active).toBe(true);
    expect(await verifyPassword(password, rows[0].password_hash)).toBe(true);
  });

  it("fails validation (exit 2) when password and confirm do not match", async () => {
    const res = await runCli(
      "user1@example.com\npassword1a\npassword1b\n",
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("passwords do not match");

    const pool = getDbPool();
    const { rowCount } = await pool.query(
      "SELECT 1 FROM users WHERE email=$1",
      ["user1@example.com"],
    );
    expect(rowCount).toBe(0);
  });

  it("fails validation (exit 2) when password is too short", async () => {
    const res = await runCli("user2@example.com\nshort1\nshort1\n");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("at least 8");

    const pool = getDbPool();
    const { rowCount } = await pool.query(
      "SELECT 1 FROM users WHERE email=$1",
      ["user2@example.com"],
    );
    expect(rowCount).toBe(0);
  });

  it("exits 3 on conflict without --force, leaving the existing row untouched", async () => {
    const email = "dup@example.com";
    const first = await runCli(`${email}\nfirstpass1\nfirstpass1\n`);
    expect(first.code).toBe(0);

    const pool = getDbPool();
    const before = await pool.query(
      "SELECT password_hash FROM users WHERE email=$1",
      [email],
    );
    const originalHash = before.rows[0].password_hash;

    const second = await runCli(`${email}\nsecondpass2\nsecondpass2\n`);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain("--force");

    const after = await pool.query(
      "SELECT password_hash FROM users WHERE email=$1",
      [email],
    );
    expect(after.rows[0].password_hash).toBe(originalHash);
  });

  it("upserts with --force, replacing the password hash", async () => {
    const email = "upsert@example.com";
    const first = await runCli(`${email}\noriginalpw1\noriginalpw1\n`);
    expect(first.code).toBe(0);

    const pool = getDbPool();
    const before = await pool.query(
      "SELECT password_hash FROM users WHERE email=$1",
      [email],
    );
    const originalHash = before.rows[0].password_hash;

    const newPassword = "replacedpw2";
    const second = await runCli(
      `${email}\n${newPassword}\n${newPassword}\n`,
      ["--force"],
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`updated admin: ${email}`);

    const after = await pool.query(
      "SELECT password_hash, role, is_active FROM users WHERE email=$1",
      [email],
    );
    expect(after.rows[0].password_hash).not.toBe(originalHash);
    expect(after.rows[0].role).toBe("admin");
    expect(after.rows[0].is_active).toBe(true);
    expect(
      await verifyPassword(newPassword, after.rows[0].password_hash),
    ).toBe(true);
  });

  it("never echoes the plaintext password to stdout", async () => {
    const email = "silent@example.com";
    const password = "tops3cretvalueZ"; // distinctive string unlikely to appear otherwise
    const res = await runCli(`${email}\n${password}\n${password}\n`);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain(password);
    expect(res.stderr).not.toContain(password);
  });
});
