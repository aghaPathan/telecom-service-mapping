import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import bcrypt from "bcryptjs";

// E2E for /isolations page introduced in #58:
// - Nav "Isolations" link lands on /isolations with heading.
// - The filter form (vendor input) is present.
// - Submitting the vendor filter updates the URL query params.
//   The test uses the form's GET action so the URL reflects the filter.

const VIEWER = {
  email: "e2e-isolations@example.com",
  password: "hunter2hunter2",
};

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for E2E isolations seeding");
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

test.describe.serial("isolations (#58) — /isolations page and filter", () => {
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

  test("clicking 'Isolations' in nav lands on /isolations with heading", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/");

    await page
      .getByTestId("nav-row-1")
      .getByRole("link", { name: "Isolations" })
      .click();
    await page.waitForURL(/\/isolations/, { timeout: 10_000 });

    expect(new URL(page.url()).pathname).toBe("/isolations");
    await expect(page.getByRole("heading", { name: "Isolations" })).toBeVisible();
  });

  test("filter form with vendor input is present on /isolations", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/isolations");
    await page.waitForLoadState("networkidle");

    // The filter form contains labelled inputs for device and vendor.
    await expect(page.getByRole("textbox", { name: /filter by vendor/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /filter by device/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /filter/i })).toBeVisible();
  });

  test("applying vendor filter updates URL with ?vendor= query param", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/isolations");
    await page.waitForLoadState("networkidle");

    await page
      .getByRole("textbox", { name: /filter by vendor/i })
      .fill("huawei");
    await page.getByRole("button", { name: /filter/i }).click();

    // The form uses method="get" so the filter value becomes a query param.
    await page.waitForURL(/vendor=huawei/, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("vendor")).toBe("huawei");

    // Page must still render the heading (no crash after filtering).
    await expect(page.getByRole("heading", { name: "Isolations" })).toBeVisible();
  });
});
