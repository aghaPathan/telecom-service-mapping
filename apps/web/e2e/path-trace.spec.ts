import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #9 path-trace: seed a linear Customer→CSG→UPE→CORE chain
// plus an islanded device and a Service anchored at the CSG. Drive the
// device/service detail pages through Caddy and verify the rendered path.

const VIEWER = {
  email: "e2e-path@example.com",
  password: "hunter2hunter2",
};

const CUST = "E2E-PATH-CUST";
const CSG = "E2E-PATH-CSG";
const UPE = "E2E-PATH-UPE";
const CORE = "E2E-PATH-CORE";
const ISLAND = "E2E-PATH-ISLAND";
const SERVICE_CID = "E2E-PATH-CID";
const MOBILY_CID = "E2E-PATH-MOB";

const ALL_DEVICES = [CUST, CSG, UPE, CORE, ISLAND];

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

test.describe.serial("path-trace (#9) — rendered hops on device/service pages", () => {
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
      // Constraints + indexes (idempotent). The ingestor normally creates
      // these, but smoke mode skips writer.ts, so make sure they exist before
      // the page-level Cypher runs.
      await s.run(
        "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (sv:Service) REQUIRE sv.cid IS UNIQUE",
      );
      await s.run(
        "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (sv:Service) ON (sv.mobily_cid)",
      );
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );

      // Devices — use MERGE so re-runs don't fail on the Device(name) unique
      // constraint. Role-specific secondary labels mirror what the ingestor
      // writes so the RoleBadge renders the expected colour.
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:Customer, d.role = 'Customer', d.level = 5,
                         d.site = 'E2E-SITE', d.domain = 'Mpls'`,
        { name: CUST },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:CSG, d.role = 'CSG', d.level = 3,
                         d.site = 'E2E-SITE', d.domain = 'Mpls'`,
        { name: CSG },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:UPE, d.role = 'UPE', d.level = 2,
                         d.site = 'E2E-SITE', d.domain = 'Mpls'`,
        { name: UPE },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:CORE, d.role = 'CORE', d.level = 1,
                         d.site = 'E2E-SITE', d.domain = 'Mpls'`,
        { name: CORE },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:CSG, d.role = 'CSG', d.level = 3,
                         d.site = 'E2E-ISLAND', d.domain = 'Mpls'`,
        { name: ISLAND },
      );

      // Edges — stored direction is canonical; traversal is undirected.
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
        { a: CUST, b: CSG, a_if: "cust-gi0/0", b_if: "csg-gi1/1" },
      );
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
        { a: CSG, b: UPE, a_if: "csg-gi1/2", b_if: "upe-gi2/1" },
      );
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
        { a: UPE, b: CORE, a_if: "upe-gi2/2", b_if: "core-gi3/1" },
      );

      // Service anchored at the CSG (source endpoint).
      await s.run(
        `MERGE (sv:Service {cid: $cid})
           ON CREATE SET sv.mobily_cid = $mc, sv.bandwidth = '1G',
                         sv.protection_type = 'unprotected',
                         sv.region = 'E2E'`,
        { cid: SERVICE_CID, mc: MOBILY_CID },
      );
      await s.run(
        `MATCH (sv:Service {cid: $cid}), (d:Device {name: $name})
         MERGE (sv)-[:TERMINATES_AT {role: 'source'}]->(d)`,
        { cid: SERVICE_CID, name: CSG },
      );
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
      await s.run(`MATCH (sv:Service {cid: $cid}) DETACH DELETE sv`, {
        cid: SERVICE_CID,
      });
      await s.run(
        `MATCH (d:Device) WHERE d.name IN $names DETACH DELETE d`,
        { names: ALL_DEVICES },
      );
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test("device page renders the full Customer→Core path in order", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/path/${CUST}`);
    await expect(page.getByTestId("device-page-name")).toContainText(CUST);

    const hops = page.getByTestId("path-hop-name");
    await expect(hops).toHaveCount(4);
    // Order matters — nth() is 0-indexed over the DOM order of the <ol>.
    await expect(hops.nth(0)).toContainText(CUST);
    await expect(hops.nth(1)).toContainText(CSG);
    await expect(hops.nth(2)).toContainText(UPE);
    await expect(hops.nth(3)).toContainText(CORE);

    // The Core hop is the terminator; confirm its row (role badge carries the
    // text "CORE") is visible on the page.
    await expect(page.getByTestId("path-view")).toContainText("CORE");
  });

  test("omnibox → service page → path starting at source endpoint", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.getByTestId("omnibox-input").fill(MOBILY_CID);
    const row = page.getByTestId("omnibox-row").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(SERVICE_CID);
    await row.click();

    await page.waitForURL(new RegExp(`/service/${SERVICE_CID}`));
    await expect(page.getByTestId("service-page-cid")).toContainText(
      SERVICE_CID,
    );

    // Service input starts at the `source` endpoint (CSG), not at the
    // customer — so we expect 3 hops, not 4.
    const hops = page.getByTestId("path-hop-name");
    await expect(hops).toHaveCount(3);
    await expect(hops.nth(0)).toContainText(CSG);
    await expect(hops.nth(1)).toContainText(UPE);
    await expect(hops.nth(2)).toContainText(CORE);
  });

  test("island device shows 'No core reachable' with unreached_at hint", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/path/${ISLAND}`);
    await expect(page.getByTestId("device-page-name")).toContainText(ISLAND);

    const panel = page.getByTestId("path-no-path");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/no core reachable/i);
    // unreached_at for a truly islanded node collapses to the start device.
    await expect(panel).toContainText(ISLAND);
  });
});
