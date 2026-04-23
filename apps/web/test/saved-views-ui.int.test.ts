import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";
import { hashPassword } from "@/lib/password";
import type { Role } from "@/lib/rbac";
import { createView, listViews, type Actor } from "@/lib/saved-views-db";

// Drift guard: the MyViewsDropdown UI consumes { id, name, kind, visibility,
// payload, owner_user_id } from GET /api/views. GET /api/views just returns
// `{ views: await listViews(...) }`, so asserting the listViews shape keeps
// the dropdown and backend in lockstep.

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
}, 120_000);

afterAll(async () => {
  await closeDbPool();
  await closeWebPool();
  await pg.stop();
});

async function makeUser(role: Role, emailPrefix: string): Promise<Actor> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      `${emailPrefix}-${Date.now()}-${Math.random()}@example.com`,
      await hashPassword("password123"),
      role,
    ],
  );
  return { id: rows[0]!.id, role };
}

beforeEach(async () => {
  await getPool().query(`TRUNCATE saved_views, users RESTART IDENTITY CASCADE`);
});

describe("saved-views list shape for MyViewsDropdown", () => {
  it("returns the exact fields the dropdown consumes", async () => {
    const op = await makeUser("operator", "op");

    await createView(op, {
      name: "drift-guard-path",
      payload: {
        kind: "path",
        query: { kind: "device", value: "E2E-SV-CSG" },
      },
      visibility: "role:viewer",
    });
    await createView(op, {
      name: "drift-guard-downstream",
      payload: {
        kind: "downstream",
        query: { device: "E2E-SV-UPE", include_transport: true, max_depth: 6 },
      },
      visibility: "private",
    });

    const views = await listViews(op);
    expect(views).toHaveLength(2);

    for (const v of views) {
      expect(typeof v.id).toBe("string");
      expect(typeof v.name).toBe("string");
      expect(["path", "downstream"]).toContain(v.kind);
      expect([
        "private",
        "role:viewer",
        "role:operator",
        "role:admin",
      ]).toContain(v.visibility);
      expect(typeof v.owner_user_id).toBe("string");
      expect(v.payload).toBeDefined();
      expect(["path", "downstream"]).toContain(v.payload.kind);
    }

    const path = views.find((v) => v.kind === "path")!;
    expect(path.payload.kind).toBe("path");
    if (path.payload.kind === "path") {
      expect(path.payload.query.kind).toBe("device");
      expect(path.payload.query.value).toBe("E2E-SV-CSG");
    }

    const down = views.find((v) => v.kind === "downstream")!;
    expect(down.payload.kind).toBe("downstream");
    if (down.payload.kind === "downstream") {
      expect(down.payload.query.device).toBe("E2E-SV-UPE");
      expect(down.payload.query.include_transport).toBe(true);
      expect(down.payload.query.max_depth).toBe(6);
    }
  });
});
