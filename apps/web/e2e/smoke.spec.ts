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

test("header freshness badge renders", async ({ page }) => {
  await page.goto("/");
  const badge = page.getByTestId("freshness-badge");
  await expect(badge).toBeVisible();
  // In smoke mode there may be no ingestion_runs row — badge degrades to
  // "No ingest yet". In full mode it shows "Last refresh: …". Either is valid.
  const text = (await badge.textContent()) ?? "";
  expect(text.length).toBeGreaterThan(0);
});

test("/api/ingestion/status returns 200 with typed shape", async ({
  request,
}) => {
  const res = await request.get("/api/ingestion/status");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("latest");
  expect(body).toHaveProperty("graph");
});

test("/api/ingestion/run denies unauthenticated POST", async ({ request }) => {
  const res = await request.post("/api/ingestion/run");
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("forbidden");
});
