import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #38 /topology viewer: seed a small MAIN site (path + ego
// modes) plus a BIG site with 4 UPEs (exceeds CLUSTER_THRESHOLD=3, so core
// overview collapses them). Drives the /topology page through Caddy and
// verifies reactflow-rendered nodes for each URL mode.

const VIEWER = {
  email: "e2e-topology@example.com",
  password: "hunter2hunter2",
};

// MAIN site — linear chain for path/ego modes.
const MAIN_CORE = "E2E-TOPO-CORE";
const MAIN_UPE = "E2E-TOPO-UPE";
const MAIN_CSG = "E2E-TOPO-CSG";
const MAIN_CUST = "E2E-TOPO-CUST";

// BIG site — fan-out UPEs to trigger clustering.
const BIG_CORE = "E2E-TOPO-BIG-CORE";
const BIG_UPE_1 = "E2E-TOPO-BIG-UPE-01";
const BIG_UPE_2 = "E2E-TOPO-BIG-UPE-02";
const BIG_UPE_3 = "E2E-TOPO-BIG-UPE-03";
const BIG_UPE_4 = "E2E-TOPO-BIG-UPE-04";

const ALL_DEVICES = [
  MAIN_CORE,
  MAIN_UPE,
  MAIN_CSG,
  MAIN_CUST,
  BIG_CORE,
  BIG_UPE_1,
  BIG_UPE_2,
  BIG_UPE_3,
  BIG_UPE_4,
];

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for E2E");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function neoDriver(): Driver {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const pass = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !pass) {
    throw new Error("NEO4J_URI/USER/PASSWORD required for E2E");
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, pass));
}

async function loginViaForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

type DeviceSeed = {
  name: string;
  role: string;
  level: number;
  site: string;
  label: string; // role-code secondary label (mirrors ingestor writer)
};

const DEVICE_SEEDS: DeviceSeed[] = [
  { name: MAIN_CORE, role: "CORE", level: 1, site: "E2E-TOPO-MAIN", label: "CORE" },
  { name: MAIN_UPE, role: "UPE", level: 2, site: "E2E-TOPO-MAIN", label: "UPE" },
  { name: MAIN_CSG, role: "CSG", level: 3, site: "E2E-TOPO-MAIN", label: "CSG" },
  { name: MAIN_CUST, role: "Customer", level: 5, site: "E2E-TOPO-MAIN", label: "Customer" },
  { name: BIG_CORE, role: "CORE", level: 1, site: "E2E-TOPO-BIG", label: "CORE" },
  { name: BIG_UPE_1, role: "UPE", level: 2, site: "E2E-TOPO-BIG", label: "UPE" },
  { name: BIG_UPE_2, role: "UPE", level: 2, site: "E2E-TOPO-BIG", label: "UPE" },
  { name: BIG_UPE_3, role: "UPE", level: 2, site: "E2E-TOPO-BIG", label: "UPE" },
  { name: BIG_UPE_4, role: "UPE", level: 2, site: "E2E-TOPO-BIG", label: "UPE" },
];

type EdgeSeed = { a: string; b: string; a_if: string; b_if: string };

const EDGE_SEEDS: EdgeSeed[] = [
  // MAIN chain: CUST–CSG–UPE–CORE
  { a: MAIN_CUST, b: MAIN_CSG, a_if: "cust-gi0/0", b_if: "csg-gi1/1" },
  { a: MAIN_CSG, b: MAIN_UPE, a_if: "csg-gi1/2", b_if: "upe-gi2/1" },
  { a: MAIN_UPE, b: MAIN_CORE, a_if: "upe-gi2/2", b_if: "core-gi3/1" },
  // BIG fan-out: each UPE to BIG_CORE
  { a: BIG_UPE_1, b: BIG_CORE, a_if: "upe-gi0/1", b_if: "core-gi1/1" },
  { a: BIG_UPE_2, b: BIG_CORE, a_if: "upe-gi0/1", b_if: "core-gi1/2" },
  { a: BIG_UPE_3, b: BIG_CORE, a_if: "upe-gi0/1", b_if: "core-gi1/3" },
  { a: BIG_UPE_4, b: BIG_CORE, a_if: "upe-gi0/1", b_if: "core-gi1/4" },
];

test.describe.serial("/topology (#38) — path, ego, and cluster modes", () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(VIEWER.password, 12);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'viewer')`,
        [VIEWER.email, hash],
      );
    });

    const drv = neoDriver();
    const s = drv.session();
    try {
      // The ingestor normally creates these; smoke mode skips writer.ts, so
      // ensure they exist before the page-level Cypher runs.
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );

      // Devices — MERGE + role-specific secondary label so the RoleBadge
      // inside reactflow device nodes renders the expected colour.
      for (const d of DEVICE_SEEDS) {
        await s.run(
          `MERGE (dev:Device {name: $name})
             ON CREATE SET dev.role = $role, dev.level = $level,
                           dev.site = $site, dev.domain = 'Mpls'
             WITH dev
             CALL apoc.create.addLabels(dev, [$label]) YIELD node
             RETURN node`,
          d,
        ).catch(async () => {
          // apoc may not be available; fall back to role-label merge without APOC.
          await s.run(
            `MERGE (dev:Device {name: $name})
               ON CREATE SET dev.role = $role, dev.level = $level,
                             dev.site = $site, dev.domain = 'Mpls'`,
            d,
          );
        });
      }

      // Edges — stored direction canonical; traversal undirected.
      for (const e of EDGE_SEEDS) {
        await s.run(
          `MATCH (a:Device {name: $a}), (b:Device {name: $b})
           MERGE (a)-[r:CONNECTS_TO]->(b)
             ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
          e,
        );
      }
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test.afterAll(async () => {
    await withPg((c) =>
      c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]),
    );
    const drv = neoDriver();
    const s = drv.session();
    try {
      await s.run(
        `MATCH (d:Device) WHERE d.name IN $names DETACH DELETE d`,
        { names: ALL_DEVICES },
      );
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test("path mode renders customer→core chain with icons", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(
      `/topology?from=device:${MAIN_CUST}&to=device:${MAIN_CORE}`,
    );
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });
    await expect(page.getByTestId("graph-device-node").first()).toBeVisible();
    await expect(page.getByTestId("graph-device-node")).toHaveCount(4);

    // Icons render inside device nodes as inline SVG.
    await expect(
      page.locator('[data-testid="graph-device-node"] svg').first(),
    ).toBeVisible();
  });

  test("ego mode around UPE with hops=1 renders 3 devices", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/topology?around=${MAIN_UPE}&hops=1`);
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });
    await expect(page.getByTestId("graph-device-node").first()).toBeVisible();
    await expect(page.getByTestId("graph-device-node")).toHaveCount(3);
  });

  test("core mode with cluster=1 collapses 4 UPEs at BIG site", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/topology?cluster=1`);
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });

    const cluster = page.getByTestId("graph-cluster-node").first();
    await expect(cluster).toBeVisible();
    // ClusterNode body reads "{count} devices" — 4 UPEs collapsed.
    await expect(cluster).toContainText("4");
  });

  test("topology with from+to renders device-to-device path", async ({
    page,
  }) => {
    // #60 — `to=device:...` makes /topology render an A→B corridor rather
    // than a to-core trace. BIG_UPE_1 and BIG_UPE_2 are both level-2 UPEs
    // hanging off BIG_CORE, so the seeded graph yields a 3-hop path
    // UPE_1 → BIG_CORE → UPE_2 (same-level endpoints, mid-tier in between).
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(
      `/topology?from=device:${BIG_UPE_1}&to=device:${BIG_UPE_2}`,
    );
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });

    // Both endpoints render as device nodes — not just the nearest-core hop.
    await expect(
      page.locator('[data-testid="graph-device-node"]', {
        hasText: BIG_UPE_1,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="graph-device-node"]', {
        hasText: BIG_UPE_2,
      }),
    ).toBeVisible();
    // 3 hops total: UPE_1 → CORE → UPE_2.
    await expect(page.getByTestId("graph-device-node")).toHaveCount(3);

    // The pre-#60 to-core "advisory" copy must be gone — /topology with
    // `to=` is now an authoritative device-to-device render.
    await expect(page.getByText(/advisory/i)).toHaveCount(0);
  });

  test("URL state round-trips after reload", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/topology?cluster=1`);
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });
    await expect(page.getByTestId("graph-cluster-node").first()).toBeVisible();

    await page.reload();
    await page.getByTestId("graph-canvas").waitFor({ state: "visible" });
    await expect(page.getByTestId("graph-cluster-node").first()).toBeVisible();
  });
});
