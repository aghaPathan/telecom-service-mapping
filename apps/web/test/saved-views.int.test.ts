import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";
import { hashPassword } from "@/lib/password";
import type { Role } from "@/lib/rbac";
import {
  createView,
  listViews,
  getView,
  updateView,
  deleteView,
  type Actor,
} from "@/lib/saved-views-db";

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
    [`${emailPrefix}-${Date.now()}-${Math.random()}@example.com`, await hashPassword("password123"), role],
  );
  return { id: rows[0]!.id, role };
}

async function truncate() {
  await getPool().query(`TRUNCATE saved_views, users RESTART IDENTITY CASCADE`);
}

const PATH_PAYLOAD = {
  kind: "path" as const,
  query: { kind: "device" as const, value: "E2E-CORE-01" },
};

const DOWN_PAYLOAD = {
  kind: "downstream" as const,
  query: { device: "E2E-UPE-01", max_depth: 5, include_transport: false },
};

describe("saved-views CRUD happy path", () => {
  beforeEach(async () => {
    await truncate();
  });

  it("create → list → get → update → delete", async () => {
    const op = await makeUser("operator", "op");

    const created = await createView(op, {
      name: "my-path",
      payload: PATH_PAYLOAD,
      visibility: "private",
    });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") throw new Error();
    expect(created.value.owner_user_id).toBe(op.id);
    expect(created.value.kind).toBe("path");

    const list = await listViews(op);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.value.id);

    const fetched = await getView(op, created.value.id);
    expect(fetched.kind).toBe("ok");

    const patched = await updateView(op, created.value.id, {
      name: "renamed",
      visibility: "role:viewer",
    });
    expect(patched.kind).toBe("ok");
    if (patched.kind !== "ok") throw new Error();
    expect(patched.value.name).toBe("renamed");
    expect(patched.value.visibility).toBe("role:viewer");

    const deleted = await deleteView(op, created.value.id);
    expect(deleted.kind).toBe("ok");

    const afterDelete = await listViews(op);
    expect(afterDelete).toHaveLength(0);

    // Second delete → not_found (idempotent from caller's POV: state unchanged).
    const again = await deleteView(op, created.value.id);
    expect(again.kind).toBe("not_found");
  });
});

describe("saved-views visibility enforcement", () => {
  beforeEach(async () => {
    await truncate();
  });

  it("viewer cannot set any role:* visibility (share-up denied)", async () => {
    const viewer = await makeUser("viewer", "v");
    for (const v of ["role:viewer", "role:operator", "role:admin"] as const) {
      const r = await createView(viewer, {
        name: `n-${v}`,
        payload: PATH_PAYLOAD,
        visibility: v,
      });
      expect(r.kind).toBe("forbidden");
    }
  });

  it("operator cannot set role:admin but can set role:viewer / role:operator", async () => {
    const op = await makeUser("operator", "op2");

    expect(
      (await createView(op, { name: "a", payload: PATH_PAYLOAD, visibility: "role:admin" })).kind,
    ).toBe("forbidden");

    for (const v of ["private", "role:viewer", "role:operator"] as const) {
      const r = await createView(op, {
        name: `n-${v}`,
        payload: PATH_PAYLOAD,
        visibility: v,
      });
      expect(r.kind).toBe("ok");
    }
  });

  it("admin can set any visibility", async () => {
    const admin = await makeUser("admin", "ad");
    for (const v of ["private", "role:viewer", "role:operator", "role:admin"] as const) {
      const r = await createView(admin, {
        name: `n-${v}`,
        payload: PATH_PAYLOAD,
        visibility: v,
      });
      expect(r.kind).toBe("ok");
    }
  });

  it("list visibility: operator sees their own private + role:operator + role:viewer, NOT another operator's private", async () => {
    const op1 = await makeUser("operator", "op3");
    const op2 = await makeUser("operator", "op4");
    const viewer = await makeUser("viewer", "v2");

    await createView(op1, { name: "own-private", payload: PATH_PAYLOAD, visibility: "private" });
    await createView(op2, { name: "other-private", payload: PATH_PAYLOAD, visibility: "private" });
    await createView(op2, { name: "shared-op", payload: PATH_PAYLOAD, visibility: "role:operator" });
    await createView(viewer, { name: "v-private", payload: DOWN_PAYLOAD, visibility: "private" });

    // A viewer with role:viewer share:
    const admin = await makeUser("admin", "ad2");
    await createView(admin, { name: "v-share", payload: PATH_PAYLOAD, visibility: "role:viewer" });

    const names = (await listViews(op1)).map((r) => r.name).sort();
    expect(names).toEqual(["own-private", "shared-op", "v-share"]);
  });

  it("PATCH: non-owner cannot modify", async () => {
    const op1 = await makeUser("operator", "op5");
    const op2 = await makeUser("operator", "op6");
    const created = await createView(op1, {
      name: "op1-view",
      payload: PATH_PAYLOAD,
      visibility: "role:operator",
    });
    if (created.kind !== "ok") throw new Error();

    const r = await updateView(op2, created.value.id, { name: "hijacked" });
    expect(r.kind).toBe("forbidden");

    const d = await deleteView(op2, created.value.id);
    expect(d.kind).toBe("forbidden");
  });

  it("PATCH: operator cannot upgrade visibility to role:admin", async () => {
    const op = await makeUser("operator", "op7");
    const created = await createView(op, {
      name: "n",
      payload: PATH_PAYLOAD,
      visibility: "private",
    });
    if (created.kind !== "ok") throw new Error();

    const r = await updateView(op, created.value.id, { visibility: "role:admin" });
    expect(r.kind).toBe("forbidden");
  });

  it("GET :id: non-viewer role cannot read a private view they don't own", async () => {
    const op = await makeUser("operator", "op8");
    const other = await makeUser("operator", "op9");
    const created = await createView(op, {
      name: "p",
      payload: PATH_PAYLOAD,
      visibility: "private",
    });
    if (created.kind !== "ok") throw new Error();

    const r = await getView(other, created.value.id);
    expect(r.kind).toBe("forbidden");
  });
});

describe("saved-views unique name + soft delete", () => {
  beforeEach(async () => {
    await truncate();
  });

  it("rejects duplicate name per owner (non-deleted)", async () => {
    const op = await makeUser("operator", "opA");
    const a = await createView(op, { name: "dup", payload: PATH_PAYLOAD, visibility: "private" });
    expect(a.kind).toBe("ok");
    const b = await createView(op, { name: "dup", payload: PATH_PAYLOAD, visibility: "private" });
    expect(b.kind).toBe("name_conflict");
  });

  it("allows re-using a name after soft-delete", async () => {
    const op = await makeUser("operator", "opB");
    const first = await createView(op, { name: "reuse", payload: PATH_PAYLOAD, visibility: "private" });
    if (first.kind !== "ok") throw new Error();
    expect((await deleteView(op, first.value.id)).kind).toBe("ok");
    const second = await createView(op, { name: "reuse", payload: PATH_PAYLOAD, visibility: "private" });
    expect(second.kind).toBe("ok");
  });

  it("does not block different owners from using the same name", async () => {
    const op1 = await makeUser("operator", "opC");
    const op2 = await makeUser("operator", "opD");
    const a = await createView(op1, { name: "same", payload: PATH_PAYLOAD, visibility: "private" });
    const b = await createView(op2, { name: "same", payload: PATH_PAYLOAD, visibility: "private" });
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
  });
});
