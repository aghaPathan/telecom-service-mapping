import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import bcrypt from "bcryptjs";

// End-to-end proof of the auth stack (#7): seed admin + viewer directly via
// pg, drive the login form through Caddy/Next.js, check role-gated access to
// /admin/users, and exercise logout.
//
// Seeds are namespaced (`e2e-*@example.com`) so they can never collide with
// real bootstrap admins. `afterAll` deletes them so repeated runs are stable.
// CLI coverage for `create-admin` lives in unit/integration tests (batch 6);
// this suite is HTTP-level only.

const ADMIN = {
  email: "e2e-admin@example.com",
  password: "hunter2hunter2",
};
const VIEWER = {
  email: "e2e-viewer@example.com",
  password: "hunter2hunter2",
};

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL required for E2E auth seeding — set it to the same value the web container uses.",
    );
  }
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
}

test.describe.serial("auth (#7) — seed → login → RBAC → logout", () => {
  test.beforeAll(async () => {
    const [adminHash, viewerHash] = await Promise.all([
      bcrypt.hash(ADMIN.password, 12),
      bcrypt.hash(VIEWER.password, 12),
    ]);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email IN ($1,$2)`, [
        ADMIN.email,
        VIEWER.email,
      ]);
      await c.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'admin'),($3,$4,'viewer')`,
        [ADMIN.email, adminHash, VIEWER.email, viewerHash],
      );
    });
  });

  test.afterAll(async () => {
    await withPg((c) =>
      c.query(`DELETE FROM users WHERE email IN ($1,$2)`, [
        ADMIN.email,
        VIEWER.email,
      ]),
    );
  });

  test("anonymous root redirects to /login with ?next=/", async ({ page }) => {
    const res = await page.goto("/");
    // Middleware 307s to /login?next=<original>. The final URL after the
    // redirect is what we assert on.
    expect(page.url()).toContain("/login?next=%2F");
    expect(res?.ok()).toBeTruthy();
  });

  test("/api/health stays anonymous (200)", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });

  test("wrong password does not grant a session", async ({ page }) => {
    // Wrong credentials must not land the user on the authenticated landing
    // page. The exact error-surface UX (toast / query-param / page render)
    // varies with Auth.js v5 beta; the acceptance criterion here is "no
    // session established". Integration tests assert the audit + return-null
    // contract of `authenticateCredentials` directly.
    await loginViaForm(page, ADMIN.email, "definitely-wrong");
    await page.waitForLoadState("networkidle");
    await expect(page).not.toHaveURL(/^https?:\/\/[^/]+\/?$/);
    await expect(page.getByTestId("session-pill")).toHaveCount(0);
  });

  test("admin login lands on / and header shows email pill", async ({
    page,
  }) => {
    await loginViaForm(page, ADMIN.email, ADMIN.password);
    // Server action redirects to `next` (defaults to "/"). Wait for the
    // landing page to render.
    await page.waitForURL("**/", { timeout: 10_000 });
    const pill = page.getByTestId("session-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(ADMIN.email);
    await expect(pill).toContainText("admin");
  });

  test("admin can reach /admin/users and sees own row", async ({ page }) => {
    await loginViaForm(page, ADMIN.email, ADMIN.password);
    await page.waitForURL("**/");
    await page.goto("/admin/users");
    await expect(page.getByTestId("users-table")).toBeVisible();
    // The seeded admin's row must be rendered in the table body.
    await expect(
      page.getByTestId("users-table").getByText(ADMIN.email),
    ).toBeVisible();
  });

  test("viewer cannot reach /admin/users (403 from requireRole)", async ({
    page,
  }) => {
    await loginViaForm(page, VIEWER.email, VIEWER.password);
    await page.waitForURL("**/");
    // requireRole("admin") throws a 403 Response for a viewer session.
    // Next.js renders this as an error page; the users-table must NOT render.
    const response = await page.goto("/admin/users");
    // The response status from the SSR fetch is either the thrown 403 or
    // Next's error boundary (500). Either way: no users-table.
    expect(response?.status()).toBeGreaterThanOrEqual(400);
    await expect(page.getByTestId("users-table")).toHaveCount(0);
  });

  test("logout returns to /login", async ({ page }) => {
    await loginViaForm(page, ADMIN.email, ADMIN.password);
    await page.waitForURL("**/");
    await page.getByRole("button", { name: /log out/i }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("session-pill")).toHaveCount(0);
  });
});
