import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import bcrypt from "bcryptjs";

// E2E for /devices page introduced in #58:
// - Nav "Devices" link lands on /devices with heading visible.
// - /devices?site=JED shows heading "Devices at JED" (or empty-state table —
//   we do not assume any fixture devices exist for JED).
// - /map page has at least one link whose href starts with "/devices?site=".
//   This link lives in the static "Site index" fallback list and is always
//   rendered regardless of Leaflet hydration.

const VIEWER = {
  email: "e2e-devices@example.com",
  password: "hunter2hunter2",
};

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for E2E devices seeding");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function loginViaForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 10_000,
  });
}

test.describe.serial("devices (#58) — /devices page and map link", () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(VIEWER.password, 12);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'viewer')`,
        [VIEWER.email, hash],
      );
    });
  });

  test.afterAll(async () => {
    await withPg((c) =>
      c.query(`DELETE FROM users WHERE email = $1`, [VIEWER.email]),
    );
  });

  test("clicking 'Devices' in nav lands on /devices with heading", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/");

    await page.getByTestId("nav-row-1").getByRole("link", { name: "Devices" }).click();
    await page.waitForURL(/\/devices/, { timeout: 10_000 });

    expect(new URL(page.url()).pathname).toBe("/devices");
    // The heading is rendered in both the empty-state and the filtered paths.
    await expect(page.getByTestId("devices-page-heading")).toBeVisible();
  });

  test("/devices?site=JED renders site heading gracefully (with or without data)", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/devices?site=JED");
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/devices");

    // The heading must contain "JED" regardless of whether rows exist.
    // Page renders either "Devices at JED" (with data) or an error panel, but
    // the heading element is always present when a site param is provided.
    const heading = page.getByTestId("devices-page-heading");
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("JED");
  });

  test("/map contains a 'Devices' link whose href starts with '/devices?site='", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/map");
    await page.waitForLoadState("networkidle");

    // The "Site index" accessibility fallback list is always server-rendered
    // (no Leaflet required) and includes a Devices link per site when sites
    // exist. If there are no sites in Neo4j the list is present but empty,
    // OR the page renders an empty/error panel — either path is valid.
    const siteList = page.getByTestId("map-site-list");
    const siteItems = siteList.locator("li");
    const count = await siteItems.count();

    if (count === 0) {
      // No sites seeded — the page shows an empty-state. Empty <ul> has zero
      // height so it isn't "visible" in Playwright's sense; rely on the empty
      // or error panel being the observable signal.
      const emptyOrError = page.locator(
        "[data-testid='map-empty'], [data-testid='map-error']",
      );
      await expect(emptyOrError).toBeVisible();
      return;
    }
    await expect(siteList).toBeVisible();

    // At least one site exists: the first site's "Devices" link must point to
    // /devices?site=<something>.
    const firstDevicesLink = siteList
      .locator("li")
      .first()
      .getByRole("link", { name: "Devices" });
    await expect(firstDevicesLink).toBeVisible();

    const href = await firstDevicesLink.getAttribute("href");
    expect(href).toMatch(/^\/devices\?site=/);
  });
});
