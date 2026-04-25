import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";
import type { NextRequest } from "next/server";
import type { Role } from "@/lib/rbac";

// Integration test for GET /api/dwdm/graph. Mirrors api-dwdm.int.test.ts —
// mocked @/lib/session so requireRole runs the real code path, real Neo4j
// testcontainer for the resolver round-trip.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

let currentRole: Role | null = "viewer";
let redirectCalls: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
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
    // Topology:
    //   AAA -- BBB (RING-1)
    //   AAA -- CCC (RING-1)
    //   BBB -- CCC (RING-1)
    //   AAA -- DDD (RING-2)
    //   AAA -- ZZZ via :CONNECTS_TO (NOT a DWDM neighbour — must be absent)
    await session.run(
      `CREATE
        (a:Device {name:'XX-AAA-DWDM-01', role:'DWDM', level:3, site:'AAA', domain:'D'}),
        (b:Device {name:'XX-BBB-DWDM-01', role:'DWDM', level:3, site:'BBB', domain:'D'}),
        (c:Device {name:'XX-CCC-DWDM-01', role:'DWDM', level:3, site:'CCC', domain:'D'}),
        (d:Device {name:'XX-DDD-DWDM-01', role:'DWDM', level:3, site:'DDD', domain:'D'}),
        (z:Device {name:'XX-ZZZ-CORE-01', role:'CORE', level:1, site:'ZZZ', domain:'D'}),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AB',
                         snfn_cids:['SNFN-1'], mobily_cids:[],
                         src_interface:'a-to-b', dst_interface:'b-to-a'}]->(b),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AC',
                         snfn_cids:[], mobily_cids:['MOB-3'],
                         src_interface:'a-to-c', dst_interface:'c-to-a'}]->(c),
        (b)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-BC',
                         snfn_cids:['SNFN-2'], mobily_cids:[],
                         src_interface:'b-to-c', dst_interface:'c-to-b'}]->(c),
        (a)-[:DWDM_LINK {ring:'RING-2', span_name:'SPAN-AD',
                         snfn_cids:[], mobily_cids:['MOB-9'],
                         src_interface:'a-to-d', dst_interface:'d-to-a'}]->(d),
        (a)-[:CONNECTS_TO]->(z)
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
  const url = `http://test/api/dwdm/graph${qs}`;
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

async function call(qs: string): Promise<Response> {
  const { GET } = await import("@/app/api/dwdm/graph/route");
  try {
    return await GET(makeReq(qs));
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof Error && err.message.startsWith("__redirect:")) {
      return new Response(null, {
        status: 307,
        headers: { location: err.message.slice("__redirect:".length) },
      });
    }
    throw err;
  }
}

type GraphBody = {
  nodes: Array<{ name: string }>;
  edges: Array<{ a: string; b: string; ring: string | null }>;
};

describe("GET /api/dwdm/graph", () => {
  it("redirects to /login when no session (anon)", async () => {
    currentRole = null;
    redirectCalls = [];
    const res = await call("?node=XX-AAA-DWDM-01");
    expect(res.status).toBe(307);
    expect(redirectCalls).toEqual(["/login"]);
    currentRole = "viewer";
  });

  it("?node=XX-AAA-DWDM-01 returns the node + DWDM neighbours; non-DWDM neighbour absent", async () => {
    currentRole = "viewer";
    const res = await call("?node=XX-AAA-DWDM-01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;
    const names = body.nodes.map((n) => n.name).sort();
    expect(names).toContain("XX-AAA-DWDM-01");
    expect(names).toContain("XX-BBB-DWDM-01");
    expect(names).toContain("XX-CCC-DWDM-01");
    expect(names).toContain("XX-DDD-DWDM-01");
    // :CONNECTS_TO neighbour must NOT appear in DWDM-only sub-graph.
    expect(names).not.toContain("XX-ZZZ-CORE-01");
    // 3 incident DWDM edges (AAA-BBB, AAA-CCC, AAA-DDD).
    expect(body.edges.length).toBe(3);
  });

  it("?ring=RING-1 returns all RING-1 edges; RING-2 edge absent", async () => {
    currentRole = "viewer";
    const res = await call("?ring=RING-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;
    expect(body.edges.length).toBe(3);
    expect(body.edges.every((e) => e.ring === "RING-1")).toBe(true);
    const names = body.nodes.map((n) => n.name).sort();
    // RING-1 only touches AAA, BBB, CCC.
    expect(names).toEqual([
      "XX-AAA-DWDM-01",
      "XX-BBB-DWDM-01",
      "XX-CCC-DWDM-01",
    ]);
    // DDD only on RING-2 — must be absent.
    expect(names).not.toContain("XX-DDD-DWDM-01");
  });

  it("empty-string filter ?node= -> 400 (empty maps to undefined, neither present)", async () => {
    currentRole = "viewer";
    const res = await call("?node=");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_query");
  });

  it("both ?node and ?ring -> 400", async () => {
    currentRole = "viewer";
    const res = await call("?node=XX-AAA-DWDM-01&ring=RING-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_query");
  });

  it("neither ?node nor ?ring -> 400", async () => {
    currentRole = "viewer";
    const res = await call("");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_query");
  });

  it("unknown node -> 200 with empty arrays (not 404)", async () => {
    currentRole = "viewer";
    const res = await call("?node=DOES-NOT-EXIST");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });
});
