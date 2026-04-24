import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import neo4j, { Driver } from "neo4j-driver";
import bcrypt from "bcryptjs";

// End-to-end for #40 impact/blast-radius page: seed a linear chain, drive
// /impact/:deviceId, and verify affected-devices table + row click-through.

const VIEWER = {
  email: "e2e-impact@example.com",
  password: "hunter2hunter2",
};

const UPE = "E2E-IMPACT-UPE";
const CSG = "E2E-IMPACT-CSG";
const RAN = "E2E-IMPACT-RAN";

const ALL_DEVICES = [UPE, CSG, RAN];

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

test.describe.serial("impact (#40) — page renders affected devices and row links", () => {
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
      // Idempotent constraints — smoke-mode deployments have no writer.ts pass
      // to create them, so the page cypher would otherwise error.
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

      await seedDevice(UPE, "UPE", 2, "Nokia");
      await seedDevice(CSG, "CSG", 3, "Nokia");
      await seedDevice(RAN, "RAN", 4, "Ericsson");

      const edge = async (a: string, b: string, a_if: string, b_if: string) => {
        await s.run(
          `MATCH (a:Device {name: $a}), (b:Device {name: $b})
           MERGE (a)-[r:CONNECTS_TO]->(b)
             ON CREATE SET r.a_if = $a_if, r.b_if = $b_if`,
          { a, b, a_if, b_if },
        );
      };
      await edge(UPE, CSG, "upe-gi0/1", "csg-gi0/1");
      await edge(CSG, RAN, "csg-gi0/2", "ran-gi0/1");
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

  test("viewer visits /impact page, sees affected devices, clicks row into device detail", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));

    await page.goto(`/impact/${UPE}`);

    await expect(page.getByTestId("impact-page-name")).toContainText(
      `Impact of ${UPE}`,
    );

    const table = page.getByTestId("impact-table");
    await expect(table).toBeVisible();
    await expect(table).toContainText(CSG);
    await expect(table).toContainText(RAN);

    // Click the CSG row's device link and expect navigation into the device
    // detail page (singular /device/ — matches codebase convention).
    await table.getByRole("link", { name: CSG }).click();
    await page.waitForURL(new RegExp(`/device/${CSG}$`));
    expect(new URL(page.url()).pathname).toBe(`/device/${CSG}`);
  });
});
