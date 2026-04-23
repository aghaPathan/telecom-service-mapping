import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #12 saved-views: seed a linear Customer→CSG→UPE→CORE chain
// and two users (operator + viewer). Verify that an operator can save a view
// shared with role:viewer, the viewer sees it in "My views", clicking lands on
// the same device page with the same rendered hops, and that a viewer's own
// Save dialog only exposes "private" as a visibility option.

const OP = {
  email: "e2e-sv-op@example.com",
  password: "hunter2hunter2",
};
const VW = {
  email: "e2e-sv-vw@example.com",
  password: "hunter2hunter2",
};

const CUST = "E2E-SV-CUST";
const CSG = "E2E-SV-CSG";
const UPE = "E2E-SV-UPE";
const CORE = "E2E-SV-CORE";

const ALL_DEVICES = [CUST, CSG, UPE, CORE];
const ALL_EMAILS = [OP.email, VW.email];

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

test.describe.serial("saved-views (#12) — share-with-role round trip", () => {
  test.beforeAll(async () => {
    const opHash = await bcrypt.hash(OP.password, 12);
    const vwHash = await bcrypt.hash(VW.password, 12);
    await withPg(async (c) => {
      // FK cascade on users -> saved_views clears any prior rows too.
      await c.query(`DELETE FROM users WHERE email = ANY($1)`, [ALL_EMAILS]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'operator')`,
        [OP.email, opHash],
      );
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'viewer')`,
        [VW.email, vwHash],
      );
    });

    const drv = neoDriver();
    const s = drv.session();
    try {
      // Constraints + indexes (idempotent). Smoke mode skips writer.ts so
      // we provision the same ones path-trace.spec.ts relies on.
      await s.run(
        "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (sv:Service) REQUIRE sv.cid IS UNIQUE",
      );
      await s.run(
        "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (sv:Service) ON (sv.mobily_cid)",
      );
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );

      // Devices — MERGE so re-runs don't fail on Device(name) unique constraint.
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
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test.afterAll(async () => {
    // FK cascade on users -> saved_views clears seeded saved views too.
    await withPg((c) =>
      c.query(`DELETE FROM users WHERE email = ANY($1)`, [ALL_EMAILS]),
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

  test("operator saves with role:viewer → viewer opens and sees same hops", async ({
    browser,
  }) => {
    // --- Operator session ---
    const opCtx = await browser.newContext();
    const opPage = await opCtx.newPage();
    await loginViaForm(opPage, OP.email, OP.password);
    await opPage.waitForURL((u) => !u.pathname.startsWith("/login"));

    await opPage.goto(`/path/${CSG}`);
    await expect(opPage.getByTestId("path-view")).toBeVisible();

    await opPage.getByTestId("save-view-toggle").click();
    await opPage.getByTestId("save-view-name").fill("E2E shared CSG path");
    await opPage
      .getByTestId("save-view-visibility")
      .selectOption("role:viewer");
    await opPage.getByTestId("save-view-submit").click();
    await expect(opPage.getByTestId("save-view-ok")).toBeVisible();

    const opHops = await opPage.getByTestId("path-hop-name").allInnerTexts();
    expect(opHops.length).toBeGreaterThan(0);

    await opCtx.close();

    // --- Viewer session ---
    const vwCtx = await browser.newContext();
    const vwPage = await vwCtx.newPage();
    await loginViaForm(vwPage, VW.email, VW.password);
    await vwPage.waitForURL((u) => !u.pathname.startsWith("/login"));

    await vwPage.goto("/");
    await vwPage.getByTestId("my-views-toggle").click();
    await vwPage.getByTestId("my-views-panel").waitFor();

    const item = vwPage
      .getByTestId("my-views-item")
      .filter({ hasText: "E2E shared CSG path" });
    await expect(item).toBeVisible();
    await item.click();

    await vwPage.waitForURL(new RegExp(`/path/${CSG}$`));
    await expect(vwPage.getByTestId("path-view")).toBeVisible();
    const vwHops = await vwPage.getByTestId("path-hop-name").allInnerTexts();
    expect(vwHops).toEqual(opHops);

    await vwCtx.close();
  });

  test("viewer cannot set role:* visibility (option list is only 'private')", async ({
    page,
  }) => {
    await loginViaForm(page, VW.email, VW.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/path/${CSG}`);
    await page.getByTestId("save-view-toggle").click();
    const options = await page
      .getByTestId("save-view-visibility")
      .locator("option")
      .allInnerTexts();
    expect(options).toEqual(["private"]);
  });

  test("viewer can save a private view and see it in My views", async ({
    page,
  }) => {
    await loginViaForm(page, VW.email, VW.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/path/${CSG}`);
    await expect(page.getByTestId("path-view")).toBeVisible();

    await page.getByTestId("save-view-toggle").click();
    await page.getByTestId("save-view-name").fill("E2E viewer private");
    await page.getByTestId("save-view-submit").click();
    await expect(page.getByTestId("save-view-ok")).toBeVisible();

    await page.getByTestId("my-views-toggle").click();
    const item = page
      .getByTestId("my-views-item")
      .filter({ hasText: "E2E viewer private" });
    await expect(item).toBeVisible();
  });
});
