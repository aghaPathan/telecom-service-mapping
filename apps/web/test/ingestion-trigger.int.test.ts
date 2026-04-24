import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";

// The admin route handlers call `requireRole("admin")`. We mock it to return
// a fixed admin session keyed off a real user row seeded below; the route's
// own audit + trigger writes still hit the real DB.
const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000042";

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
  await getPool().query(
    `TRUNCATE ingestion_triggers RESTART IDENTITY`,
  );
  await getPool().query(
    `TRUNCATE ingestion_runs RESTART IDENTITY CASCADE`,
  );
  await getPool().query(`TRUNCATE audit_log RESTART IDENTITY`);
});

describe("POST /api/ingestion/run", () => {
  it("admin: inserts trigger row, returns 201 with trigger_id", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const res = await POST();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.trigger_id).toEqual(expect.any(Number));
    const { rows } = await getPool().query(
      `SELECT requested_by FROM ingestion_triggers WHERE id=$1`,
      [body.trigger_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requested_by).toBe(ADMIN_USER_ID);
  });

  it("admin: writes audit_log entry with trigger id as target", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const res = await POST();
    const { trigger_id } = await res.json();
    const { rows } = await getPool().query(
      `SELECT action, target, user_id FROM audit_log
        WHERE action='ingestion_run_triggered'
        ORDER BY at DESC LIMIT 1`,
    );
    expect(rows[0]!.action).toBe("ingestion_run_triggered");
    expect(rows[0]!.target).toBe(String(trigger_id));
    expect(rows[0]!.user_id).toBe(ADMIN_USER_ID);
  });
});

describe("GET /api/ingestion/run/[id]", () => {
  it("returns 400 for non-numeric id", async () => {
    const { GET } = await import("@/app/api/ingestion/run/[id]/route");
    const res = await GET(new Request("http://test/"), {
      params: { id: "not-a-number" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown trigger id", async () => {
    const { GET } = await import("@/app/api/ingestion/run/[id]/route");
    const res = await GET(new Request("http://test/"), {
      params: { id: "99999" },
    });
    expect(res.status).toBe(404);
  });

  it("returns pending for unclaimed trigger", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const { GET } = await import("@/app/api/ingestion/run/[id]/route");
    const post = await POST();
    const { trigger_id } = await post.json();
    const res = await GET(new Request("http://test/"), {
      params: { id: String(trigger_id) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ trigger_id, run_id: null, status: "pending" });
  });

  it("returns succeeded after attaching run_id", async () => {
    const { POST } = await import("@/app/api/ingestion/run/route");
    const { GET } = await import("@/app/api/ingestion/run/[id]/route");
    const post = await POST();
    const { trigger_id } = await post.json();
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO ingestion_runs (status, dry_run) VALUES ('succeeded', false) RETURNING id`,
    );
    const runId = Number(rows[0]!.id);
    await getPool().query(
      `UPDATE ingestion_triggers SET claimed_at=now(), run_id=$1 WHERE id=$2`,
      [runId, trigger_id],
    );
    const res = await GET(new Request("http://test/"), {
      params: { id: String(trigger_id) },
    });
    const body = await res.json();
    expect(body.status).toBe("succeeded");
    expect(body.run_id).toBe(runId);
  });
});
