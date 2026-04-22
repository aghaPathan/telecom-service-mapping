import { test, expect } from "@playwright/test";

// After middleware (#7), anonymous access to most routes redirects to /login.
// These smoke tests cover only what is reachable anonymously. Authenticated
// flows (session pill, freshness badge under login, etc.) live in
// auth.spec.ts (batch 7).

test("landing page redirects anonymous to /login", async ({ page }) => {
  // Middleware intercepts `/` for unauth'd users and sends them to /login
  // with the original path encoded in `?next=`. We assert the login form
  // renders as proof the redirect landed.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("health endpoint returns 200 with both deps ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.postgres.ok).toBe(true);
  expect(body.neo4j.ok).toBe(true);
});

test("/api/ingestion/status redirects unauthenticated caller", async ({
  request,
}) => {
  // Middleware intercepts before the route handler runs.
  const res = await request.get("/api/ingestion/status", {
    maxRedirects: 0,
  });
  expect(res.status()).toBe(307);
  expect(res.headers()["location"] ?? "").toMatch(/\/login/);
});

test("/api/ingestion/run redirects unauthenticated POST", async ({
  request,
}) => {
  // Middleware intercepts before requireRole can return 403.
  const res = await request.post("/api/ingestion/run", {
    maxRedirects: 0,
  });
  expect(res.status()).toBe(307);
  expect(res.headers()["location"] ?? "").toMatch(/\/login/);
});
