import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { renderToStaticMarkup } from "react-dom/server";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";

const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000050";

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
});

describe("/admin/ingestion page", () => {
  it("renders Run now button, empty runs table", async () => {
    const mod = await import("@/app/admin/ingestion/page");
    const element = await mod.default();
    const html = renderToStaticMarkup(element);
    expect(html).toContain('data-testid="run-now-button"');
    expect(html).toContain('data-testid="recent-runs-table"');
    expect(html).not.toContain('data-testid="recent-run-row"');
  });

  it("renders recent ingestion_runs rows, newest first", async () => {
    await getPool().query(
      `INSERT INTO ingestion_runs (status, dry_run, started_at, finished_at)
       VALUES ('failed', false, now() - interval '2 minutes', now() - interval '2 minutes'),
              ('succeeded', false, now() - interval '1 minute', now() - interval '1 minute')`,
    );
    const mod = await import("@/app/admin/ingestion/page");
    const element = await mod.default();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("succeeded");
    expect(html).toContain("failed");
    // succeeded was inserted second (newer started_at), so it appears first
    const iSucc = html.indexOf(">succeeded<");
    const iFail = html.indexOf(">failed<");
    expect(iSucc).toBeGreaterThan(-1);
    expect(iFail).toBeGreaterThan(iSucc);
  });
});
