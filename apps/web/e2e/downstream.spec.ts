import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #10 downstream/blast-radius: seed a linear chain with an MW
// (level 3.5) transport hop plus two customer leaves, then drive the
// /device/:name/downstream page and /api/downstream/csv export.

const VIEWER = {
  email: "e2e-downstream@example.com",
  password: "hunter2hunter2",
};

const CORE = "E2E-DOWN-CORE";
const UPE = "E2E-DOWN-UPE";
const CSG = "E2E-DOWN-CSG";
const MW = "E2E-DOWN-MW";
const RAN = "E2E-DOWN-RAN";
const CUST1 = "E2E-DOWN-CUST1";
const CUST2 = "E2E-DOWN-CUST2";
const SERVICE_CID = "E2E-DOWN-CID";
const MOBILY_CID = "E2E-DOWN-MOB";

const ALL_DEVICES = [CORE, UPE, CSG, MW, RAN, CUST1, CUST2];

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

test.describe.serial("downstream (#10) — page, filter, CSV export", () => {
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
      // Idempotent constraints / indexes — mirror path-trace.spec.ts so smoke
      // mode (no writer.ts) still has what the page cypher expects.
      await s.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );
      await s.run(
        "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (sv:Service) REQUIRE sv.cid IS UNIQUE",
      );
      await s.run(
        "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (sv:Service) ON (sv.mobily_cid)",
      );
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );

      // Devices — the downstream resolver only reads role/level/site/domain,
      // so we skip the role-specific secondary labels (which would require a
      // per-role MERGE statement) and stick to the primary :Device label.
      const seedDevice = async (name: string, role: string, level: number) => {
        await s.run(
          `MERGE (d:Device {name: $name})
             ON CREATE SET d.role = $role, d.level = $level,
                           d.site = 'E2E-SITE', d.domain = 'Mpls'`,
          { name, role, level },
        );
      };

      await seedDevice(CORE, "Core", 1);
      await seedDevice(UPE, "UPE", 2);
      await seedDevice(CSG, "CSG", 3);
      await seedDevice(MW, "MW", 3.5);
      await seedDevice(RAN, "RAN", 4);
      await seedDevice(CUST1, "Customer", 5);
      await seedDevice(CUST2, "Customer", 5);

      const edge = async (a: string, b: string, a_if: string, b_if: string) => {
        await s.run(
          `MATCH (a:Device {name: $a}), (b:Device {name: $b})
           MERGE (a)-[r:CONNECTS_TO]->(b)
             ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
          { a, b, a_if, b_if },
        );
      };
      await edge(CORE, UPE, "core-gi0/1", "upe-gi0/1");
      await edge(UPE, CSG, "upe-gi0/2", "csg-gi0/1");
      await edge(CSG, MW, "csg-gi0/2", "mw-gi0/1");
      await edge(MW, RAN, "mw-gi0/2", "ran-gi0/1");
      await edge(RAN, CUST1, "ran-gi0/2", "cust1-gi0/0");
      await edge(RAN, CUST2, "ran-gi0/3", "cust2-gi0/0");

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
        { cid: SERVICE_CID, name: UPE },
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

  test("viewer visits downstream page, MW hidden by default", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/device/${UPE}/downstream`);
    await expect(page.getByTestId("downstream-summary")).toBeVisible();
    await expect(page.getByTestId("downstream-summary")).toContainText(
      /customer/i,
    );

    const list = page.getByTestId("downstream-list");
    await expect(list).toContainText(CSG);
    await expect(list).toContainText(RAN);
    await expect(list).toContainText(CUST1);
    await expect(list).toContainText(CUST2);
    await expect(list).not.toContainText(MW);
  });

  test("device detail page has a 'View downstream' link that navigates", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/device/${UPE}`);
    await page.getByTestId("action-downstream").click();

    await page.waitForURL(new RegExp(`/device/${UPE}/downstream`));
    await expect(page.getByTestId("downstream-summary")).toBeVisible();
  });

  test("?include_transport=true makes MW visible", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/device/${UPE}/downstream?include_transport=true`);
    await expect(page.getByTestId("downstream-summary")).toBeVisible();
    await expect(page.getByTestId("downstream-list")).toContainText(MW);
    await expect(page.locator("body")).toContainText(MW);
  });

  test("CSV export returns text/csv with MW filtered by default", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    // Share the logged-in cookie with the APIRequestContext so the route
    // passes requireRole("viewer").
    const api = page.context().request;
    const res = await api.get(`/api/downstream/csv?device=${UPE}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(
      `filename="downstream-${UPE}.csv"`,
    );

    const body = await res.text();
    expect(body).toContain("name,role,level,site,domain");
    expect(body).toContain(CUST1);
    expect(body).not.toContain(MW);
  });
});
