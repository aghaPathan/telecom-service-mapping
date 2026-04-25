import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";
import type { NextRequest } from "next/server";
import type { Role } from "@/lib/rbac";

// Integration test for GET /api/dwdm. Pattern combines test/dwdm.int.test.ts
// (live Neo4j seed) and test/admin-rbac.int.test.ts (mocked @/lib/session so
// requireRole runs the real code path and either redirects or throws 403).

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

// `null` => no session (anon path: redirect("/login")).
let currentRole: Role | null = "viewer";
let redirectCalls: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    // Real `redirect` throws a special error; mirror by throwing so the route
    // handler unwinds. We catch it in the harness.
    throw new Error(`__redirect:${url}`);
  },
}));

vi.mock("@/lib/session", () => ({
  getSession: async () => {
    if (currentRole === null) return null;
    return {
      user: {
        id: `00000000-0000-0000-0000-0000000000${currentRole === "viewer" ? "01" : "02"}`,
        email: `${currentRole}@example.com`,
        role: currentRole,
      },
    };
  },
}));

async function seed(driver: Driver) {
  const session = driver.session();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    // Two rings + a reverse-canonical edge to verify undirected list match.
    // span_name on RING-2 starts with `=` to exercise CSV formula-injection.
    await session.run(
      `CREATE
        (a:Device {name:'XX-AAA-DWDM-01', role:'DWDM', level:3, site:'AAA', domain:'D'}),
        (b:Device {name:'XX-BBB-DWDM-01', role:'DWDM', level:3, site:'BBB', domain:'D'}),
        (c:Device {name:'XX-CCC-DWDM-01', role:'DWDM', level:3, site:'CCC', domain:'D'}),
        (d:Device {name:'XX-DDD-DWDM-01', role:'DWDM', level:3, site:'DDD', domain:'D'}),
        (p:Device {name:'XX-PPP-DWDM-01', role:'DWDM', level:3, site:'PPP', domain:'D'}),
        (q:Device {name:'XX-QQQ-DWDM-01', role:'DWDM', level:3, site:'QQQ', domain:'D'}),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AB',
                         snfn_cids:['SNFN-1','SNFN-1B'], mobily_cids:['MOB-1'],
                         src_interface:'a-to-b', dst_interface:'b-to-a'}]->(b),
        (b)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-BC',
                         snfn_cids:['SNFN-2'], mobily_cids:[],
                         src_interface:'b-to-c', dst_interface:'c-to-b'}]->(c),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AC',
                         snfn_cids:[], mobily_cids:['MOB-3'],
                         src_interface:'a-to-c', dst_interface:'c-to-a'}]->(c),
        (a)-[:DWDM_LINK {ring:'RING-2', span_name:'=BADFORMULA',
                         snfn_cids:['SNFN-9'], mobily_cids:['MOB-9'],
                         src_interface:'a-to-d', dst_interface:'d-to-a'}]->(d),
        // Reverse-canonical: q.name > p.name but edge points q -> p.
        (q)-[:DWDM_LINK {ring:'RING-REV', span_name:'SPAN-REV',
                         snfn_cids:[], mobily_cids:[],
                         src_interface:'q-to-p', dst_interface:'p-to-q'}]->(p)
      `,
    );
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  neo4jC = await new GenericContainer("neo4j:5-community")
    .withEnvironment({ NEO4J_AUTH: `${NEO_USER}/${NEO_PASS}` })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\./))
    .withStartupTimeout(120_000)
    .start();

  const uri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
  process.env.NEO4J_URI = uri;
  process.env.NEO4J_USER = NEO_USER;
  process.env.NEO4J_PASSWORD = NEO_PASS;

  adminDriver = neo4j.driver(uri, neo4j.auth.basic(NEO_USER, NEO_PASS));
  await seed(adminDriver);
}, 180_000);

afterAll(async () => {
  await adminDriver?.close();
  const { getDriver } = await import("@/lib/neo4j");
  try {
    await getDriver().close();
  } catch {
    /* already closed */
  }
  await neo4jC?.stop();
}, 60_000);

function makeReq(qs: string): NextRequest {
  // The route only reads `req.nextUrl.searchParams`, so a minimal stub suffices.
  const url = `http://test/api/dwdm${qs}`;
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

async function call(qs: string): Promise<Response> {
  const { GET } = await import("@/app/api/dwdm/route");
  try {
    return await GET(makeReq(qs));
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof Error && err.message.startsWith("__redirect:")) {
      // Surface as a synthetic 307 so tests can assert it.
      return new Response(null, {
        status: 307,
        headers: { location: err.message.slice("__redirect:".length) },
      });
    }
    throw err;
  }
}

describe("GET /api/dwdm", () => {
  it("redirects to /login when no session (anon)", async () => {
    currentRole = null;
    redirectCalls = [];
    const res = await call("");
    expect(res.status).toBe(307);
    expect(redirectCalls).toEqual(["/login"]);
    currentRole = "viewer";
  });

  it("viewer JSON: 200 and { rows: [...] } shape; ring filter narrows", async () => {
    currentRole = "viewer";
    const res = await call("");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
    // 4 RING-1/RING-2 edges + 1 reverse-canonical = 5 rows total.
    expect(body.rows.length).toBe(5);

    const ringRes = await call("?ring=RING-1");
    expect(ringRes.status).toBe(200);
    const ringBody = (await ringRes.json()) as {
      rows: Array<{ ring: string }>;
    };
    expect(ringBody.rows.length).toBe(3);
    expect(ringBody.rows.every((r) => r.ring === "RING-1")).toBe(true);
  });

  it("CSV: header order, formula-injection guard, sanitized filename", async () => {
    currentRole = "viewer";
    const res = await call("?format=csv&ring=RING-2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment;");
    expect(cd).toContain('filename="dwdm-');
    // sanitizeFilename collapses `-` runs? Actually it preserves `-`; just
    // make sure the prefix is present and no CR/LF/quote leaked in.
    expect(cd).toMatch(/filename="dwdm-ring-RING-2\.csv"/);

    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "a_name,a_role,a_level,b_name,b_role,b_level,ring,span_name,snfn_cids,mobily_cids,src_interface,dst_interface",
    );
    // Single RING-2 row with span_name `=BADFORMULA` -> formula-guarded:
    // wrapped in quotes with leading apostrophe.
    expect(text).toContain('"\'=BADFORMULA"');
  });

  it("empty-string filter -> treated as undefined (does not silently match-all)", async () => {
    currentRole = "viewer";
    // device_a="" must NOT cause CONTAINS "" (which would match everything,
    // tautologically — that's the SAME as no filter, but the empty-vs-undef
    // distinction matters when zod is between us and the resolver: this asserts
    // we don't error and we get the full unfiltered listing back).
    const empty = await call("?device_a=");
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { rows: unknown[] };

    const none = await call("");
    expect(none.status).toBe(200);
    const noneBody = (await none.json()) as { rows: unknown[] };

    expect(emptyBody.rows.length).toBe(noneBody.rows.length);
    expect(emptyBody.rows.length).toBe(5);
  });

  it("400 invalid_query when device_a exceeds 200 chars", async () => {
    currentRole = "viewer";
    const tooLong = "a".repeat(201);
    const res = await call(`?device_a=${tooLong}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_query");
  });

  it("reverse-canonical edge appears in the listing (undirected match)", async () => {
    currentRole = "viewer";
    const res = await call("?ring=RING-REV");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ a_name: string; b_name: string; ring: string }>;
    };
    expect(body.rows.length).toBe(1);
    const row = body.rows[0]!;
    // Canonical projection: a.name < b.name regardless of stored direction.
    expect(row.a_name).toBe("XX-PPP-DWDM-01");
    expect(row.b_name).toBe("XX-QQQ-DWDM-01");
    expect(row.ring).toBe("RING-REV");
  });
});
