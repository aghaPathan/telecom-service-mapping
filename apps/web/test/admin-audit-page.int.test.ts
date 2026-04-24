import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { renderToStaticMarkup } from "react-dom/server";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";

const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000060";

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
  await getPool().query(`TRUNCATE audit_log RESTART IDENTITY`);
});

describe("/admin/audit page", () => {
  it("renders all rows with no filters", async () => {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, target) VALUES
       ($1, 'x.y', 't1'),
       ($1, 'other.event', 't2')`,
      [ADMIN_USER_ID],
    );
    const mod = await import("@/app/admin/audit/page");
    const element = await mod.default({ searchParams: {} });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('data-testid="audit-table"');
    expect(html).toContain(">x.y<");
    expect(html).toContain(">other.event<");
  });

  it("filters by ?action=", async () => {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, target) VALUES
       ($1, 'x.y', 't1'),
       ($1, 'other.event', 't2')`,
      [ADMIN_USER_ID],
    );
    const mod = await import("@/app/admin/audit/page");
    const element = await mod.default({
      searchParams: { action: "x.y" },
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(">x.y<");
    expect(html).not.toContain(">other.event<");
  });

  it("filters by ?user_id=", async () => {
    const otherUserId = "00000000-0000-0000-0000-000000000061";
    await getPool().query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, 'other@example.com', 'x', 'viewer')
       ON CONFLICT DO NOTHING`,
      [otherUserId],
    );
    await getPool().query(
      `INSERT INTO audit_log (user_id, action) VALUES ($1, 'admin.action')`,
      [ADMIN_USER_ID],
    );
    await getPool().query(
      `INSERT INTO audit_log (user_id, action) VALUES ($1, 'viewer.action')`,
      [otherUserId],
    );
    const mod = await import("@/app/admin/audit/page");
    const element = await mod.default({
      searchParams: { user_id: otherUserId },
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(">viewer.action<");
    expect(html).not.toContain(">admin.action<");
  });

  it("orders newest first", async () => {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, at) VALUES
       ($1, 'old.event', now() - interval '1 hour'),
       ($1, 'new.event', now())`,
      [ADMIN_USER_ID],
    );
    const mod = await import("@/app/admin/audit/page");
    const element = await mod.default({ searchParams: {} });
    const html = renderToStaticMarkup(element);
    expect(html.indexOf(">new.event<")).toBeLessThan(
      html.indexOf(">old.event<"),
    );
  });
});
