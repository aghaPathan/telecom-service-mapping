import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #39 device-detail page. Seed an ICSG with one UPE
// neighbor (uplink) plus two RAN neighbors (downlink), hit the detail
// page as a viewer and verify the header + Neighbors section + action
// link wiring + 404 behavior for an unknown device.

const VIEWER = {
  email: "e2e-detail@example.com",
  password: "hunter2hunter2",
};

const ICSG = "E2E-DETAIL-ICSG";
const UPE = "E2E-DETAIL-UPE";
const RAN1 = "E2E-DETAIL-RAN-1";
const RAN2 = "E2E-DETAIL-RAN-2";
const MISSING = "E2E-DETAIL-NO-SUCH-DEVICE";

const ALL_DEVICES = [ICSG, UPE, RAN1, RAN2];

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
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test.describe.serial("device-detail (#39) — header + neighbors + 404", () => {
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
      // Constraints + indexes (idempotent) — smoke mode skips writer.ts.
      await s.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );

      // Devices — role-specific secondary labels verbatim per CLAUDE.md.
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:CSG, d.role = 'CSG', d.level = 3,
                         d.site = 'JED', d.vendor = 'Huawei', d.domain = 'D'`,
        { name: ICSG },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:UPE, d.role = 'UPE', d.level = 2,
                         d.site = 'JED', d.vendor = 'Huawei', d.domain = 'D'`,
        { name: UPE },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:Ran, d.role = 'Ran', d.level = 4,
                         d.site = 'JED', d.vendor = 'Huawei', d.domain = 'D'`,
        { name: RAN1 },
      );
      await s.run(
        `MERGE (d:Device {name: $name})
           ON CREATE SET d:Ran, d.role = 'Ran', d.level = 4,
                         d.site = 'JED', d.vendor = 'Huawei', d.domain = 'D'`,
        { name: RAN2 },
      );

      // Edges — stored direction is canonical (lesser→greater level);
      // traversal is undirected so neighbor lookup picks up all three.
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if, r.status = true`,
        { a: UPE, b: ICSG, a_if: "upe-to-icsg", b_if: "icsg-to-upe" },
      );
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if, r.status = true`,
        { a: ICSG, b: RAN1, a_if: "icsg-to-ran1", b_if: "ran1-to-icsg" },
      );
      await s.run(
        `MATCH (a:Device {name: $a}), (b:Device {name: $b})
         MERGE (a)-[r:CONNECTS_TO]->(b)
           ON CREATE SET r.a_if = $a_if, r.b_if = $b_if, r.status = true`,
        { a: ICSG, b: RAN2, a_if: "icsg-to-ran2", b_if: "ran2-to-icsg" },
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
      await s.run(
        `MATCH (d:Device) WHERE d.name IN $names DETACH DELETE d`,
        { names: ALL_DEVICES },
      );
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test("detail page renders header + neighbors", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);

    const resp = await page.goto(`/device/${encodeURIComponent(ICSG)}`);
    expect(resp?.status()).toBe(200);
    await expect(page.getByTestId("device-page-name")).toContainText(ICSG);

    const neighbors = page.getByTestId("neighbors");
    await expect(neighbors).toBeVisible();
    await expect(
      neighbors.locator(`a[href="/device/${UPE}"]`),
    ).toBeVisible();
    await expect(
      neighbors.locator(`a[href="/device/${RAN1}"]`),
    ).toBeVisible();
    await expect(
      neighbors.locator(`a[href="/device/${RAN2}"]`),
    ).toBeVisible();
  });

  test("action links navigate correctly", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto(`/device/${encodeURIComponent(ICSG)}`);

    // Topology + impact: only assert href — routes may not fully handle
    // seeded data yet, so clicking risks a flaky hop.
    await expect(page.getByTestId("action-topology")).toHaveAttribute(
      "href",
      `/topology?around=${ICSG}`,
    );
    await expect(page.getByTestId("action-impact")).toHaveAttribute(
      "href",
      `/impact/${ICSG}`,
    );

    await page.getByTestId("action-trace").click();
    await expect(page).toHaveURL(new RegExp(`/path/${ICSG}(?:$|[/?#])`));

    await page.goto(`/device/${encodeURIComponent(ICSG)}`);
    await page.getByTestId("action-downstream").click();
    await expect(page).toHaveURL(
      new RegExp(`/device/${ICSG}/downstream(?:$|[/?#])`),
    );
  });

  test("unknown device returns 404", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);

    const resp = await page.goto(`/device/${encodeURIComponent(MISSING)}`);
    expect(resp?.status()).toBe(404);
    await expect(page.getByTestId("device-not-found")).toBeVisible();
  });
});
