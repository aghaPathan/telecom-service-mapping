import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";
import type { Role } from "@/lib/rbac";

// Contract test: every admin-gated route throws 403 for viewer and operator,
// and returns a 2xx/4xx (not 403) for admin. We mock `@/lib/session` so real
// `requireRole` runs — the throw-403 path is what we want to exercise, not a
// mocked shortcut.

const ROLE_IDS: Record<Role, string> = {
  admin: "00000000-0000-0000-0000-000000000070",
  operator: "00000000-0000-0000-0000-000000000071",
  viewer: "00000000-0000-0000-0000-000000000072",
};

let currentRole: Role = "admin";

vi.mock("next/navigation", () => ({
  // `redirect` throws; we never reach it because we always set a role.
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
}));

vi.mock("@/lib/session", () => ({
  getSession: async () => ({
    user: {
      id: ROLE_IDS[currentRole],
      email: `${currentRole}@example.com`,
      role: currentRole,
    },
  }),
}));

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
  for (const [role, id] of Object.entries(ROLE_IDS)) {
    await getPool().query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3::user_role)
       ON CONFLICT DO NOTHING`,
      [id, `${role}@example.com`, role],
    );
  }
}, 180_000);

afterAll(async () => {
  await closeDbPool();
  await closeWebPool();
  await pg.stop();
});

type RouteCase = {
  name: string;
  call: () => Promise<Response>;
};

// Keep the call sites lazy so the imports run inside the mocked module graph.
const ROUTES: RouteCase[] = [
  {
    name: "POST /api/ingestion/run",
    call: async () => {
      const { POST } = await import("@/app/api/ingestion/run/route");
      return POST();
    },
  },
  {
    name: "GET /api/ingestion/run/[id]",
    call: async () => {
      const { GET } = await import("@/app/api/ingestion/run/[id]/route");
      return GET(new Request("http://test/"), { params: { id: "1" } });
    },
  },
  {
    name: "GET /admin/ingestion (page)",
    call: async () => {
      const mod = await import("@/app/admin/ingestion/page");
      // Server components return JSX on success; we only care that they
      // reach render on admin and throw 403 on lower roles.
      await mod.default();
      return new Response("ok", { status: 200 });
    },
  },
  {
    name: "GET /admin/audit (page)",
    call: async () => {
      const mod = await import("@/app/admin/audit/page");
      await mod.default({ searchParams: {} });
      return new Response("ok", { status: 200 });
    },
  },
  {
    name: "GET /admin/users (page)",
    call: async () => {
      const mod = await import("@/app/admin/users/page");
      await mod.default();
      return new Response("ok", { status: 200 });
    },
  },
];

async function runWithRole(role: Role, call: RouteCase["call"]): Promise<Response> {
  currentRole = role;
  try {
    return await call();
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

describe.each(ROUTES)("$name RBAC contract", ({ call }) => {
  it("returns 403 for viewer", async () => {
    const res = await runWithRole("viewer", call);
    expect(res.status).toBe(403);
  });
  it("returns 403 for operator", async () => {
    const res = await runWithRole("operator", call);
    expect(res.status).toBe(403);
  });
  it("admin: not 403", async () => {
    const res = await runWithRole("admin", call);
    expect(res.status).not.toBe(403);
  });
});
