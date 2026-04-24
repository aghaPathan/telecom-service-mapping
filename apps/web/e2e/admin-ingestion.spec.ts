import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import bcrypt from "bcryptjs";

/**
 * E2E for the admin "Run now" flow.
 *
 * Scope: prove the REAL browser path — login → click button → POST
 * /api/ingestion/run returns 201 → client polls /api/ingestion/run/[id] →
 * status transitions from `pending` to `succeeded`.
 *
 * We deliberately do NOT wait for the real ingestor cron to pick up the
 * trigger. The claim protocol (FOR UPDATE SKIP LOCKED + attachRunToTrigger)
 * is already integration-tested against a real Postgres in
 * `apps/ingestor/test/cron.int.test.ts` — reproducing it in Playwright would
 * be flaky and require full (non-smoke) ingestor mode, which the CI overlay
 * doesn't enable. Instead, we simulate the ingestor side with a pg UPDATE
 * and verify the web's poll/render path.
 *
 * Cleanup is scoped to the seeded admin's user id (and the trigger/run rows
 * that reference it). `ingestion_runs` has no namespace column, so the
 * `afterAll` DELETE targets specifically the `run_id` returned by the
 * simulated claim — never a blanket delete.
 */

const ADMIN = {
  email: "e2e-ingest-admin@example.com",
  password: "hunter2hunter2",
};

async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL required for E2E seeding — set it to the same value the web container uses.",
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
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 10_000,
  });
}

test.describe.serial("admin Run now — golden path (#62)", () => {
  let adminId: string;
  // Track every run/trigger row we create so afterAll can remove them
  // deterministically regardless of how many retries happen.
  const simulatedRunIds: number[] = [];

  test.beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN.password, 12);
    await withPg(async (c) => {
      await c.query(`DELETE FROM users WHERE email = $1`, [ADMIN.email]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'admin') RETURNING id`,
        [ADMIN.email, hash],
      );
      adminId = rows[0]!.id;
    });
  });

  test.afterAll(async () => {
    await withPg(async (c) => {
      // Triggers first (FK to ingestion_runs), then the simulated runs,
      // then the admin user (sessions CASCADE on user delete).
      await c.query(
        `DELETE FROM ingestion_triggers WHERE requested_by = $1`,
        [adminId],
      );
      if (simulatedRunIds.length > 0) {
        await c.query(
          `DELETE FROM ingestion_runs WHERE id = ANY($1::bigint[])`,
          [simulatedRunIds],
        );
      }
      await c.query(`DELETE FROM users WHERE id = $1`, [adminId]);
    });
  });

  test("click Run now → poll → status=succeeded", async ({ page }) => {
    await loginViaForm(page, ADMIN.email, ADMIN.password);
    await page.goto("/admin/ingestion");
    await expect(page.getByTestId("run-now-button")).toBeVisible();
    await expect(page.getByTestId("recent-runs-table")).toBeVisible();

    // Click + capture the 201 so we know the trigger_id without scraping DOM.
    const [postResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/ingestion/run") && r.request().method() === "POST",
      ),
      page.getByTestId("run-now-button").click(),
    ]);
    expect(postResponse.status()).toBe(201);
    const { trigger_id } = (await postResponse.json()) as {
      trigger_id: number;
    };
    expect(typeof trigger_id).toBe("number");

    // UI shows `pending` while the client polls /api/ingestion/run/[id].
    await expect(page.getByTestId("run-now-status")).toHaveText("pending", {
      timeout: 5_000,
    });

    // Simulate the ingestor's tickCron: INSERT a succeeded ingestion_runs
    // row and attach it to the claimed trigger. In production this is what
    // apps/ingestor/src/cron.ts does inside its 60s cron window.
    const runId = await withPg(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO ingestion_runs (status, dry_run, finished_at)
         VALUES ('succeeded', false, now()) RETURNING id`,
      );
      const id = Number(rows[0]!.id);
      await c.query(
        `UPDATE ingestion_triggers SET claimed_at = now(), run_id = $1 WHERE id = $2`,
        [id, trigger_id],
      );
      return id;
    });
    simulatedRunIds.push(runId);

    // Client polls every 2s; allow a couple of intervals plus slack.
    await expect(page.getByTestId("run-now-status")).toHaveText("succeeded", {
      timeout: 10_000,
    });

    // The recent-runs table re-renders on next navigation and must include
    // the simulated run.
    await page.reload();
    await expect(
      page.getByTestId("recent-runs-table").getByText("succeeded").first(),
    ).toBeVisible();
  });
});
