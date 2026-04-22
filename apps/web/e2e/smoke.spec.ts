import { test, expect } from "@playwright/test";

test("landing page shows seed device count", async ({ page }) => {
  await page.goto("/");
  const el = page.getByTestId("device-count");
  await expect(el).toBeVisible();
  await expect(el).toHaveText("Devices in graph: 1");
});

test("health endpoint returns 200 with both deps ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.postgres.ok).toBe(true);
  expect(body.neo4j.ok).toBe(true);
});
