import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import bcrypt from "bcryptjs";

// E2E for the two-row nav introduced in #58:
// - Row 1 is always visible for authenticated users.
// - Row 2 (admin links) is only visible to admins.
// - Each row-1 link navigates to the right path without 404.

const VIEWER = {
  email: "e2e-nav-viewer@example.com",
  password: "hunter2hunter2",
};
const ADMIN = {
  email: "e2e-nav-admin@example.com",
  password: "hunter2hunter2",
};

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for E2E nav seeding");
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

test.describe.serial("nav (#58) — two-row nav", () => {
  test.beforeAll(async () => {
    const [viewerHash, adminHash] = await Promise.all([
      bcrypt.hash(VIEWER.password, 12),
      bcrypt.hash(ADMIN.password, 12),
    ]);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email IN ($1,$2)`, [
        VIEWER.email,
        ADMIN.email,
      ]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'viewer'),($3,$4,'admin')`,
        [VIEWER.email, viewerHash, ADMIN.email, adminHash],
      );
    });
  });

  test.afterAll(async () => {
    await withPg((c) =>
      c.query(`DELETE FROM users WHERE email IN ($1,$2)`, [
        VIEWER.email,
        ADMIN.email,
      ]),
    );
  });

  test("viewer sees nav-row-1 and does NOT see nav-row-2", async ({ page }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.goto("/");
    await expect(page.getByTestId("app-nav")).toBeVisible();
    await expect(page.getByTestId("nav-row-1")).toBeVisible();
    await expect(page.getByTestId("nav-row-2")).toHaveCount(0);
  });

  test("admin sees both nav-row-1 and nav-row-2", async ({ page }) => {
    await loginViaForm(page, ADMIN.email, ADMIN.password);
    await page.goto("/");
    await expect(page.getByTestId("app-nav")).toBeVisible();
    await expect(page.getByTestId("nav-row-1")).toBeVisible();
    await expect(page.getByTestId("nav-row-2")).toBeVisible();
  });

  // Verify each row-1 link navigates to the right path (not 404).
  // Strategy: after click, assert that the app-nav is still present (meaning
  // Next.js rendered a real page, not an error boundary). Each page is
  // protected by requireRole("viewer") so a 404 would remove app-nav.
  const ROW1_LINKS = [
    { label: "Home", path: "/" },
    { label: "Devices", path: "/devices" },
    { label: "Core", path: "/core" },
    { label: "Topology", path: "/topology" },
    { label: "Map", path: "/map" },
    { label: "Analytics", path: "/analytics" },
    { label: "Isolations", path: "/isolations" },
    { label: "Ingestion", path: "/ingestion" },
  ];

  for (const { label, path } of ROW1_LINKS) {
    test(`row-1 link "${label}" navigates to ${path} without error`, async ({
      page,
    }) => {
      await loginViaForm(page, VIEWER.email, VIEWER.password);
      await page.goto("/");

      // Click the nav link by its text.
      await page.getByTestId("nav-row-1").getByRole("link", { name: label }).click();
      await page.waitForLoadState("networkidle");

      // URL must contain the expected path.
      expect(new URL(page.url()).pathname).toBe(path);

      // The nav must still be rendered (proves no unhandled 404/500).
      await expect(page.getByTestId("app-nav")).toBeVisible();
    });
  }
});
