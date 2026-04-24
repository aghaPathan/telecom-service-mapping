import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #41 /analytics page: seed three RAN devices with distinct
// fanout, drive /analytics?role=RAN, and verify the top-fanout row links into
// the device detail page.

const VIEWER = {
  email: "e2e-analytics@example.com",
  password: "hunter2hunter2",
};

const HIGH = "E2E-ANALYTICS-RAN-HIGH";
const MID = "E2E-ANALYTICS-RAN-MID";
const LOW = "E2E-ANALYTICS-RAN-LOW";
const HUB1 = "E2E-ANALYTICS-HUB-1";
const HUB2 = "E2E-ANALYTICS-HUB-2";
const HUB3 = "E2E-ANALYTICS-HUB-3";

const ALL_DEVICES = [HIGH, MID, LOW, HUB1, HUB2, HUB3];

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

test.describe.serial("analytics (#41) — top-fanout table row links into detail", () => {
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
      // Idempotent constraint — smoke-mode deployments have no writer.ts pass
      // to create it, so the page cypher would otherwise error.
      await s.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );

      const seedDevice = async (
        name: string,
        role: string,
        level: number,
        vendor: string,
      ) => {
        await s.run(
          `MERGE (d:Device {name: $name})
             ON CREATE SET d.role = $role, d.level = $level,
                           d.site = 'E2E-SITE', d.domain = 'Mpls',
                           d.vendor = $vendor`,
          { name, role, level, vendor },
        );
      };

      // RANs under test — fanout 3 / 2 / 1 so /analytics?role=RAN orders
      // them deterministically HIGH, MID, LOW.
      await seedDevice(HIGH, "RAN", 4, "Ericsson");
      await seedDevice(MID, "RAN", 4, "Ericsson");
      await seedDevice(LOW, "RAN", 4, "Ericsson");

      // Hubs — peers for edges. Role/level don't matter for the fanout count.
      await seedDevice(HUB1, "UPE", 2, "Nokia");
      await seedDevice(HUB2, "UPE", 2, "Nokia");
      await seedDevice(HUB3, "UPE", 2, "Nokia");

      const edge = async (a: string, b: string, a_if: string, b_if: string) => {
        await s.run(
          `MATCH (a:Device {name: $a}), (b:Device {name: $b})
           MERGE (a)-[r:CONNECTS_TO]->(b)
             ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
          { a, b, a_if, b_if },
        );
      };

      // HIGH — 3 neighbours
      await edge(HIGH, HUB1, "high-gi0/1", "hub1-gi0/1");
      await edge(HIGH, HUB2, "high-gi0/2", "hub2-gi0/1");
      await edge(HIGH, HUB3, "high-gi0/3", "hub3-gi0/1");
      // MID — 2 neighbours
      await edge(MID, HUB1, "mid-gi0/1", "hub1-gi0/2");
      await edge(MID, HUB2, "mid-gi0/2", "hub2-gi0/2");
      // LOW — 1 neighbour
      await edge(LOW, HUB1, "low-gi0/1", "hub1-gi0/3");
    } finally {
      await s.close();
      await drv.close();
    }
  });

  test.afterAll(async () => {
    try {
      await withPg((c) =>
        c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]),
      );
    } finally {
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
    }
  });

  test("viewer visits /analytics, sees fanout-desc ordering, clicks top row into device detail", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto("/analytics?role=RAN&limit=3");

    const table = page.getByTestId("rft-table");
    await expect(table).toBeVisible();

    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(3);

    // Top row (fanout desc) must be HIGH.
    await expect(rows.first()).toContainText(HIGH);

    await table.getByRole("link", { name: HIGH }).click();
    await page.waitForURL(new RegExp(`/device/${HIGH}$`));
    expect(new URL(page.url()).pathname).toBe(`/device/${HIGH}`);

    // Device name should be visible on the detail page.
    await expect(page.getByText(HIGH).first()).toBeVisible();
  });
});
