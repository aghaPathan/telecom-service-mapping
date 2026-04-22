import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #8 omnibox: seed a Device + Service into Neo4j (via the
// localhost bolt mapping from docker-compose.ci.yml), seed a viewer user,
// drive the search box through Caddy, and verify both search-result
// navigation and role-based access.

const VIEWER = {
  email: "e2e-omnibox@example.com",
  password: "hunter2hunter2",
};

const DEVICE_NAME = "E2E-OMNI-UPE-01";
const SERVICE_CID = "E2E-CID-001";
const MOBILY_CID = "E2E-MOB-001";

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

test.describe.serial("omnibox (#8) — search → navigate", () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(VIEWER.password, 12);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'viewer')`,
        [VIEWER.email, hash],
      );
    });

    // Seed graph. Smoke ingest creates the Device constraint + seed-01
    // device but not the service constraint or fulltext index — make
    // sure those exist before the omnibox queries run.
    const drv = neoDriver();
    const s = drv.session();
    try {
      await s.run(
        "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.cid IS UNIQUE",
      );
      await s.run(
        "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (s:Service) ON (s.mobily_cid)",
      );
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:UPE, d.role = 'UPE', d.level = 2,
                         d.site = 'E2E-SITE', d.domain = 'Mpls'`,
        { name: DEVICE_NAME },
      );
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
        { cid: SERVICE_CID, name: DEVICE_NAME },
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
      await s.run(`MATCH (d:Device {name: $name}) DETACH DELETE d`, {
        name: DEVICE_NAME,
      });
      await s.run(`MATCH (sv:Service {cid: $cid}) DETACH DELETE sv`, {
        cid: SERVICE_CID,
      });
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test("anonymous /api/search is blocked by middleware", async ({
    request,
  }) => {
    // Middleware 307s to /login; the fetch follows redirects and lands on
    // the login page HTML, not JSON. Assert we did NOT get search JSON.
    const res = await request.get("/api/search?q=anything");
    expect(res.ok()).toBeTruthy();
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).not.toContain("application/json");
  });

  test("viewer can search by device name and navigate to stub", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.getByTestId("omnibox-input").fill(DEVICE_NAME);
    const row = page.getByTestId("omnibox-row").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(DEVICE_NAME);
    await row.click();

    await page.waitForURL(new RegExp(`/device/${DEVICE_NAME}`));
    await expect(page.getByTestId("device-page-name")).toContainText(
      DEVICE_NAME,
    );
  });

  test("viewer searching by mobily_cid lands on service stub", async ({
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
  });

  test("keyboard Enter on first result navigates", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    const input = page.getByTestId("omnibox-input");
    await input.fill(DEVICE_NAME);
    await expect(page.getByTestId("omnibox-row").first()).toBeVisible();
    await input.press("Enter");

    await page.waitForURL(new RegExp(`/device/${DEVICE_NAME}`));
  });
});
