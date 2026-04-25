import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";

// Exercise Zod validation + flavor persistence on POST /api/ingestion/run.
// `@/lib/rbac` is mocked so the route reaches the body-parse / DB write paths
// directly; the RBAC contract is owned by admin-rbac.int.test.ts.

const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000043";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({
    user: { id: ADMIN_USER_ID, email: "admin@example.com", role: "admin" },
  }),
}));

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
  await getPool().query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'admin@example.com', 'x', 'admin')
     ON CONFLICT DO NOTHING`,
    [ADMIN_USER_ID],
  );
}, 180_000);

afterAll(async () => {
  await closeDbPool();
  await closeWebPool();
  await pg.stop();
});

beforeEach(async () => {
  await getPool().query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
  await getPool().query(`TRUNCATE ingestion_runs RESTART IDENTITY CASCADE`);
  await getPool().query(`TRUNCATE audit_log RESTART IDENTITY`);
});

async function readFlavor(triggerId: number): Promise<string> {
  const { rows } = await getPool().query<{ flavor: string }>(
    `SELECT flavor FROM ingestion_triggers WHERE id=$1`,
    [triggerId],
  );
  return rows[0]!.flavor;
}

describe("POST /api/ingestion/run — flavor", () => {
  it("no body → 201 with flavor='full' (default)", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const res = await POST();
    expect(res.status).toBe(201);
    const { trigger_id } = (await res.json()) as { trigger_id: number };
    expect(trigger_id).toEqual(expect.any(Number));
    expect(await readFlavor(trigger_id)).toBe("full");
  });

  it("body { flavor: 'isis_cost' } → 201 with flavor='isis_cost'", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const req = new Request("http://test/api/ingestion/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flavor: "isis_cost" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { trigger_id } = (await res.json()) as { trigger_id: number };
    expect(await readFlavor(trigger_id)).toBe("isis_cost");
  });

  it("body { flavor: 'bogus' } → 400 (Zod rejection)", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const req = new Request("http://test/api/ingestion/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flavor: "bogus" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM ingestion_triggers`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("empty JSON body {} → 201 with flavor='full'", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const req = new Request("http://test/api/ingestion/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const { trigger_id } = (await res.json()) as { trigger_id: number };
    expect(await readFlavor(trigger_id)).toBe("full");
  });
});
