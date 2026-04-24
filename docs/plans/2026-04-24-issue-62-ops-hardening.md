# Slice 5: Ops Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire manual ingestion trigger, ship admin surfaces, tighten compose readiness, add HSTS/CSP, enforce RBAC via contract tests.

**Architecture:** See design doc `docs/plans/2026-04-24-issue-62-ops-hardening-design.md`. Four areas: A1 trigger, A2 admin pages, A3 compose/healthcheck, A4 edge hardening.

**Tech Stack:** Next.js 14 App Router, TypeScript, Postgres 13, Neo4j 5, Caddy, Docker Compose, Vitest + testcontainers, Playwright.

**Repo invariants already in place (do not re-do):**
- `apps/web/middleware.ts` **already 404s** `/design-preview` and `/graph-preploy` in prod (lines 17-23). Task is test coverage only.
- `ingestion_runs.status` values are `'running'`, `'succeeded'`, `'failed'` (not `'success'`). Healthcheck must match `succeeded`/`running`.
- Nav row 2 (`apps/web/app/_components/nav.tsx:17-20`) has `Users`, `Audit`. Task is adding `Ingestion`.
- Cron scheduler (`apps/ingestor/src/cron.ts`) runs `tickCron` on a cron expression. Trigger poll must hook into `tickCron` so the existing `hasRunningRun` mutex is respected.
- Branch naming convention enforced by hook: `{type}/{description}`. Use `feat/issue-62-ops-hardening`.

---

## Task 1: Migration — `ingestion_triggers` table

**Files:**
- Create: `packages/db/migrations/1700000000040_ingestion-triggers.sql`

**Step 1: Write the migration**

```sql
CREATE TABLE ingestion_triggers (
  id            BIGSERIAL PRIMARY KEY,
  requested_by  UUID NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at    TIMESTAMPTZ,
  run_id        BIGINT REFERENCES ingestion_runs(id)
);

CREATE INDEX ingestion_triggers_unclaimed_idx
  ON ingestion_triggers (requested_at)
  WHERE claimed_at IS NULL;
```

**Step 2: Rebuild `@tsm/db` so migrations ship**

Run: `pnpm --filter @tsm/db build`
Expected: `dist/` updated, no errors.

**Step 3: Commit**

```bash
git add packages/db/migrations/1700000000040_ingestion-triggers.sql
git commit -m "feat: add ingestion_triggers table (#62)"
```

---

## Task 2: Ingestor — `claimTrigger` helper (TDD)

**Files:**
- Create: `apps/ingestor/src/triggers.ts`
- Create: `apps/ingestor/test/triggers.int.test.ts`

**Step 1: Write the failing test**

```ts
// apps/ingestor/test/triggers.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "@tsm/db";
import { claimNextTrigger, attachRunToTrigger } from "../src/triggers.js";

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await migrate(pool);
  // seed a user row so FK holds
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES
     ('00000000-0000-0000-0000-000000000001', 'a@b.c', 'x', 'admin')`
  );
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pg.stop();
});

describe("claimNextTrigger", () => {
  it("returns null when no unclaimed triggers", async () => {
    const got = await claimNextTrigger(pool);
    expect(got).toBeNull();
  });

  it("claims the oldest unclaimed trigger atomically", async () => {
    await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
    await pool.query(
      `INSERT INTO ingestion_triggers (requested_by) VALUES
       ('00000000-0000-0000-0000-000000000001'),
       ('00000000-0000-0000-0000-000000000001')`
    );
    const first = await claimNextTrigger(pool);
    expect(first?.id).toBe(1);
    // second call should get the next row because first is now claimed
    const second = await claimNextTrigger(pool);
    expect(second?.id).toBe(2);
    const third = await claimNextTrigger(pool);
    expect(third).toBeNull();
  });

  it("attachRunToTrigger writes the run_id", async () => {
    await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
    await pool.query(
      `INSERT INTO ingestion_triggers (requested_by) VALUES
       ('00000000-0000-0000-0000-000000000001')`
    );
    const t = await claimNextTrigger(pool);
    expect(t).not.toBeNull();
    await attachRunToTrigger(pool, t!.id, 42);
    const { rows } = await pool.query(
      `SELECT run_id FROM ingestion_triggers WHERE id=$1`, [t!.id]
    );
    expect(rows[0].run_id).toBe("42"); // bigint comes back as string
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter ingestor test triggers.int.test.ts`
Expected: FAIL — `../src/triggers.js` not found.

**Step 3: Write minimal implementation**

```ts
// apps/ingestor/src/triggers.ts
import type { Pool } from "pg";

export type ClaimedTrigger = { id: number; requested_by: string };

/**
 * Atomically claim the oldest unclaimed trigger row. Uses
 * FOR UPDATE SKIP LOCKED so concurrent claimers never block each other.
 * Returns null if no unclaimed trigger exists.
 */
export async function claimNextTrigger(pool: Pool): Promise<ClaimedTrigger | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query<{ id: string; requested_by: string }>(
      `SELECT id, requested_by FROM ingestion_triggers
         WHERE claimed_at IS NULL
         ORDER BY requested_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
    );
    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = sel.rows[0]!;
    await client.query(
      `UPDATE ingestion_triggers SET claimed_at = now() WHERE id = $1`,
      [row.id]
    );
    await client.query("COMMIT");
    return { id: Number(row.id), requested_by: row.requested_by };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Attach a completed run id to a previously-claimed trigger row.
 */
export async function attachRunToTrigger(
  pool: Pool,
  triggerId: number,
  runId: number
): Promise<void> {
  await pool.query(
    `UPDATE ingestion_triggers SET run_id = $2 WHERE id = $1`,
    [triggerId, runId]
  );
}
```

**Step 4: Run tests — green**

Run: `pnpm --filter ingestor test triggers.int.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add apps/ingestor/src/triggers.ts apps/ingestor/test/triggers.int.test.ts
git commit -m "feat: add claimNextTrigger helper for manual ingest triggers (#62)"
```

---

## Task 3: Ingestor — wire trigger polling into tickCron

**Files:**
- Modify: `apps/ingestor/src/cron.ts`
- Modify: `apps/ingestor/src/index.ts` (`runFn` must report back `runId`)
- Create/extend: `apps/ingestor/test/cron.int.test.ts` (add trigger-integration cases)

**Step 1: Write the failing integration test**

Add to `apps/ingestor/test/cron.int.test.ts` (or create if missing):

```ts
it("tickCron claims a pending trigger and attaches run_id when runFn succeeds", async () => {
  await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
  await pool.query(`TRUNCATE ingestion_runs RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO ingestion_triggers (requested_by) VALUES
     ('00000000-0000-0000-0000-000000000001')`
  );
  const runFn = vi.fn(async (): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ingestion_runs (status, dry_run) VALUES ('succeeded', false) RETURNING id`
    );
    return Number(rows[0]!.id);
  });
  const outcome = await tickCron(pool, runFn);
  expect(outcome.action).toBe("ran");
  expect(runFn).toHaveBeenCalledOnce();
  const { rows } = await pool.query(
    `SELECT run_id, claimed_at FROM ingestion_triggers WHERE id=1`
  );
  expect(rows[0].run_id).not.toBeNull();
  expect(rows[0].claimed_at).not.toBeNull();
});

it("tickCron leaves trigger unclaimed when a run is already running", async () => {
  await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
  await pool.query(`TRUNCATE ingestion_runs RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO ingestion_runs (status, dry_run) VALUES ('running', false)`
  );
  await pool.query(
    `INSERT INTO ingestion_triggers (requested_by) VALUES
     ('00000000-0000-0000-0000-000000000001')`
  );
  const runFn = vi.fn(async () => 0);
  const outcome = await tickCron(pool, runFn);
  expect(outcome.action).toBe("skipped");
  expect(runFn).not.toHaveBeenCalled();
  const { rows } = await pool.query(
    `SELECT claimed_at FROM ingestion_triggers WHERE id=1`
  );
  expect(rows[0].claimed_at).toBeNull(); // still pending
});
```

**Step 2: Run — fail**

Run: `pnpm --filter ingestor test cron.int.test.ts`
Expected: FAIL.

**Step 3: Update `tickCron` signature and body**

Change `runFn` to return `Promise<number | null>` (the run_id, or null if nothing ran). Claim trigger BEFORE running; attach run_id after.

```ts
// apps/ingestor/src/cron.ts
import type { Pool } from "pg";
import cron from "node-cron";
import { log } from "./logger.js";
import { hasRunningRun, recordSkip } from "./runs.js";
import { claimNextTrigger, attachRunToTrigger } from "./triggers.js";

export type TickOutcome =
  | { action: "ran"; runId: number; triggerId: number | null }
  | { action: "skipped"; reason: string; runId: number }
  | { action: "errored"; error: string };

/**
 * runFn returns the ingestion_runs.id it wrote (or null for a no-op).
 */
export async function tickCron(
  pool: Pool,
  runFn: () => Promise<number | null>,
): Promise<TickOutcome> {
  if (await hasRunningRun(pool)) {
    const reason = "prior run still in flight";
    const runId = await recordSkip(pool, reason);
    log("warn", "ingest_skipped_overlap", { runId, reason });
    return { action: "skipped", reason, runId };
  }
  const trigger = await claimNextTrigger(pool);
  try {
    const runId = await runFn();
    if (runId !== null && trigger) {
      await attachRunToTrigger(pool, trigger.id, runId);
    }
    return { action: "ran", runId: runId ?? 0, triggerId: trigger?.id ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("error", "cron_run_failed", { error });
    return { action: "errored", error };
  }
}

export function startScheduler(opts: {
  cronExpr: string;
  pool: Pool;
  runFn: () => Promise<number | null>;
}): { stop: () => void } {
  if (!cron.validate(opts.cronExpr)) {
    throw new Error(`Invalid cron expression: ${opts.cronExpr}`);
  }
  log("info", "cron_started", { cron: opts.cronExpr });
  const task = cron.schedule(opts.cronExpr, () => {
    void tickCron(opts.pool, opts.runFn);
  });
  return {
    stop: () => {
      task.stop();
      log("info", "cron_stopped", { cron: opts.cronExpr });
    },
  };
}
```

**Step 4: Update `index.ts` runFn to return runId**

In `apps/ingestor/src/index.ts` around lines 360-380, change the scheduler's `runFn`:

```ts
const runFn = async (): Promise<number | null> => {
  const result = await runIngest({ dryRun: false, config });
  return result.runId;
};
```

(`runIngest` already returns `{ runId, ... }` — just forward it.)

**Step 5: Run tests — green**

Run: `pnpm --filter ingestor test`
Expected: PASS (all, including existing cron tests if present — their `runFn` signature will need updating to return a number if they currently return void; fix those as part of the same commit).

**Step 6: Commit**

```bash
git add apps/ingestor/src/cron.ts apps/ingestor/src/index.ts apps/ingestor/test/cron.int.test.ts
git commit -m "feat: tickCron claims pending triggers and attaches run_id (#62)"
```

---

## Task 4: Web API — `POST /api/ingestion/run` writes trigger + `GET /api/ingestion/run/[id]` polls

**Files:**
- Modify: `apps/web/app/api/ingestion/run/route.ts`
- Create: `apps/web/app/api/ingestion/run/[id]/route.ts`
- Create: `apps/web/lib/ingestion-triggers.ts`
- Create: `apps/web/test/ingestion-trigger.int.test.ts`

**Step 1: Write the failing integration test**

```ts
// apps/web/test/ingestion-trigger.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// reuse existing test harness from other *.int.test.ts files
import { setupIntEnv, teardownIntEnv, asAdmin, asOperator, asViewer, fetchAs } from "./helpers/int-env";

let env: Awaited<ReturnType<typeof setupIntEnv>>;
beforeAll(async () => { env = await setupIntEnv(); }, 180_000);
afterAll(async () => { await teardownIntEnv(env); });

describe("POST /api/ingestion/run", () => {
  it("returns 403 for viewer and operator", async () => {
    for (const role of [asOperator, asViewer]) {
      const res = await fetchAs(env, role, "/api/ingestion/run", { method: "POST" });
      expect(res.status).toBe(403);
    }
  });

  it("admin: inserts trigger row, returns 201 with trigger_id", async () => {
    const res = await fetchAs(env, asAdmin, "/api/ingestion/run", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.trigger_id).toEqual(expect.any(Number));
    const { rows } = await env.pg.query(
      `SELECT requested_by FROM ingestion_triggers WHERE id=$1`,
      [body.trigger_id]
    );
    expect(rows).toHaveLength(1);
  });

  it("admin: writes audit_log entry", async () => {
    const res = await fetchAs(env, asAdmin, "/api/ingestion/run", { method: "POST" });
    const { trigger_id } = await res.json();
    const { rows } = await env.pg.query(
      `SELECT action, target FROM audit_log WHERE action='ingestion_run_triggered' ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].action).toBe("ingestion_run_triggered");
    expect(rows[0].target).toBe(String(trigger_id));
  });
});

describe("GET /api/ingestion/run/[id]", () => {
  it("returns 404 for unknown trigger id", async () => {
    const res = await fetchAs(env, asAdmin, "/api/ingestion/run/99999");
    expect(res.status).toBe(404);
  });

  it("returns pending for unclaimed trigger", async () => {
    const post = await fetchAs(env, asAdmin, "/api/ingestion/run", { method: "POST" });
    const { trigger_id } = await post.json();
    const res = await fetchAs(env, asAdmin, `/api/ingestion/run/${trigger_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ trigger_id, run_id: null, status: "pending" });
  });

  it("returns succeeded after attaching run_id", async () => {
    const post = await fetchAs(env, asAdmin, "/api/ingestion/run", { method: "POST" });
    const { trigger_id } = await post.json();
    const { rows } = await env.pg.query(
      `INSERT INTO ingestion_runs (status, dry_run) VALUES ('succeeded', false) RETURNING id`
    );
    const runId = rows[0].id;
    await env.pg.query(
      `UPDATE ingestion_triggers SET claimed_at=now(), run_id=$1 WHERE id=$2`,
      [runId, trigger_id]
    );
    const res = await fetchAs(env, asAdmin, `/api/ingestion/run/${trigger_id}`);
    const body = await res.json();
    expect(body.status).toBe("succeeded");
    expect(body.run_id).toBe(Number(runId));
  });
});
```

**Step 2: Run — fail**

Run: `pnpm --filter web test:int ingestion-trigger.int.test.ts`
Expected: FAIL — route does not exist / returns 200 instead of 201.

**Step 3: Implement `lib/ingestion-triggers.ts`**

```ts
// apps/web/lib/ingestion-triggers.ts
import { getPool } from "@tsm/db";

export async function createTrigger(userId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ingestion_triggers (requested_by) VALUES ($1) RETURNING id`,
    [userId]
  );
  return Number(rows[0]!.id);
}

export type TriggerStatus = {
  trigger_id: number;
  run_id: number | null;
  status: "pending" | "running" | "succeeded" | "failed";
};

export async function getTriggerStatus(triggerId: number): Promise<TriggerStatus | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string; run_id: string | null; run_status: string | null;
  }>(
    `SELECT t.id, t.run_id, r.status AS run_status
       FROM ingestion_triggers t
       LEFT JOIN ingestion_runs r ON r.id = t.run_id
      WHERE t.id = $1`,
    [triggerId]
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    trigger_id: Number(row.id),
    run_id: row.run_id === null ? null : Number(row.run_id),
    status: (row.run_status ?? "pending") as TriggerStatus["status"],
  };
}
```

**Step 4: Rewrite `POST /api/ingestion/run/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { createTrigger } from "@/lib/ingestion-triggers";

export async function POST() {
  const session = await requireRole("admin");
  const triggerId = await createTrigger(session.user.id);
  await recordAudit(session.user.id, "ingestion_run_triggered", String(triggerId), {});
  return NextResponse.json({ trigger_id: triggerId }, { status: 201 });
}
```

**Step 5: Create `GET /api/ingestion/run/[id]/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getTriggerStatus } from "@/lib/ingestion-triggers";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  await requireRole("admin");
  const triggerId = Number(params.id);
  if (!Number.isFinite(triggerId) || triggerId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const status = await getTriggerStatus(triggerId);
  if (!status) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(status);
}
```

**Step 6: Run tests — green**

Run: `pnpm --filter web test:int ingestion-trigger.int.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add apps/web/app/api/ingestion/run/route.ts \
        apps/web/app/api/ingestion/run/\[id\]/route.ts \
        apps/web/lib/ingestion-triggers.ts \
        apps/web/test/ingestion-trigger.int.test.ts
git commit -m "feat: POST /api/ingestion/run writes trigger, GET polls by id (#62)"
```

---

## Task 5: Admin page — `/admin/ingestion`

**Files:**
- Create: `apps/web/app/admin/ingestion/page.tsx`
- Create: `apps/web/app/admin/ingestion/run-now-button.tsx`
- Create: `apps/web/test/admin-ingestion-page.int.test.ts`

**Step 1: Write failing integration test**

```ts
// apps/web/test/admin-ingestion-page.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupIntEnv, teardownIntEnv, asAdmin, asOperator, asViewer, fetchAs } from "./helpers/int-env";

let env: Awaited<ReturnType<typeof setupIntEnv>>;
beforeAll(async () => { env = await setupIntEnv(); }, 180_000);
afterAll(async () => { await teardownIntEnv(env); });

describe("/admin/ingestion", () => {
  it.each([["operator", asOperator], ["viewer", asViewer]] as const)(
    "returns 403 for %s", async (_label, who) => {
      const res = await fetchAs(env, who, "/admin/ingestion");
      expect(res.status).toBe(403);
    }
  );

  it("admin: renders 'Run now' button and recent runs table", async () => {
    await env.pg.query(
      `INSERT INTO ingestion_runs (status, dry_run, finished_at)
       VALUES ('succeeded', false, now())`
    );
    const res = await fetchAs(env, asAdmin, "/admin/ingestion");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="run-now-button"');
    expect(html).toContain('data-testid="recent-runs-table"');
    expect(html).toContain("succeeded");
  });
});
```

**Step 2: Run — fail**

**Step 3: Implement page**

```tsx
// apps/web/app/admin/ingestion/page.tsx
import { requireRole } from "@/lib/rbac";
import { getPool } from "@tsm/db";
import { RunNowButton } from "./run-now-button";

export const dynamic = "force-dynamic";

type RunRow = {
  id: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  skipped: boolean;
  error_text: string | null;
};

async function loadRecentRuns(): Promise<RunRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<RunRow>(
    `SELECT id, status, started_at, finished_at, skipped, error_text
       FROM ingestion_runs
       ORDER BY started_at DESC
       LIMIT 20`
  );
  return rows;
}

export default async function AdminIngestionPage() {
  await requireRole("admin");
  const runs = await loadRecentRuns();
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Ingestion</h1>
      <RunNowButton />
      <table data-testid="recent-runs-table" className="text-sm">
        <thead><tr><th>Id</th><th>Status</th><th>Started</th><th>Finished</th><th>Skipped</th><th>Error</th></tr></thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.status}</td>
              <td>{new Date(r.started_at).toISOString()}</td>
              <td>{r.finished_at ? new Date(r.finished_at).toISOString() : "—"}</td>
              <td>{r.skipped ? "yes" : "no"}</td>
              <td>{r.error_text ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

```tsx
// apps/web/app/admin/ingestion/run-now-button.tsx
"use client";
import { useState } from "react";

export function RunNowButton() {
  const [state, setState] = useState<{ status: string; triggerId?: number; runId?: number | null }>({ status: "idle" });
  async function click() {
    setState({ status: "triggering" });
    const r = await fetch("/api/ingestion/run", { method: "POST" });
    if (!r.ok) { setState({ status: "error" }); return; }
    const { trigger_id } = await r.json();
    setState({ status: "pending", triggerId: trigger_id });
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await fetch(`/api/ingestion/run/${trigger_id}`);
      if (!s.ok) continue;
      const body = await s.json();
      if (body.status !== "pending") {
        setState({ status: body.status, triggerId: trigger_id, runId: body.run_id });
        return;
      }
    }
    setState({ status: "timeout", triggerId: trigger_id });
  }
  return (
    <div>
      <button
        data-testid="run-now-button"
        onClick={click}
        disabled={state.status === "triggering" || state.status === "pending"}
        className="px-3 py-1 rounded bg-slate-900 text-white disabled:opacity-50"
      >
        Run now
      </button>
      <span className="ml-3 text-sm" data-testid="run-now-status">{state.status}</span>
    </div>
  );
}
```

**Step 4: Test green, commit**

```bash
pnpm --filter web test:int admin-ingestion-page.int.test.ts
git add apps/web/app/admin/ingestion/ apps/web/test/admin-ingestion-page.int.test.ts
git commit -m "feat: /admin/ingestion page with Run now button and recent runs (#62)"
```

---

## Task 6: Admin page — `/admin/audit`

**Files:**
- Create: `apps/web/app/admin/audit/page.tsx`
- Create: `apps/web/test/admin-audit-page.int.test.ts`

**Step 1: Write failing test**

```ts
// Test: admin renders audit_log filtered by ?action= and ?user_id=
// Non-admin: 403 on GET /admin/audit
it("admin: renders audit_log rows filtered by ?action=", async () => {
  await env.pg.query(`INSERT INTO audit_log (user_id, action) VALUES ($1, 'x.y')`, [env.adminUserId]);
  await env.pg.query(`INSERT INTO audit_log (user_id, action) VALUES ($1, 'other')`, [env.adminUserId]);
  const res = await fetchAs(env, asAdmin, "/admin/audit?action=x.y");
  const html = await res.text();
  expect(html).toContain("x.y");
  expect(html).not.toContain(">other<");
});
```

**Step 2: Implement**

Server component reads query params (`action`, `user_id`, `date_from`, `date_to`, `page`), WHERE-builds a parameterised query, joins `users` for email, renders table with data-testids `audit-table` and per-row.

```tsx
// apps/web/app/admin/audit/page.tsx
import { requireRole } from "@/lib/rbac";
import { getPool } from "@tsm/db";

export const dynamic = "force-dynamic";

type Row = { id: number; action: string; target: string | null; created_at: string; email: string | null; metadata_json: unknown };

function buildWhere(sp: { action?: string; user_id?: string; date_from?: string; date_to?: string }) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (sp.action)    { params.push(sp.action);    clauses.push(`a.action = $${params.length}`); }
  if (sp.user_id)   { params.push(sp.user_id);   clauses.push(`a.user_id = $${params.length}`); }
  if (sp.date_from) { params.push(sp.date_from); clauses.push(`a.created_at >= $${params.length}`); }
  if (sp.date_to)   { params.push(sp.date_to);   clauses.push(`a.created_at <  $${params.length}`); }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

export default async function AdminAuditPage({ searchParams }: {
  searchParams: Record<string, string | undefined>;
}) {
  await requireRole("admin");
  const page  = Math.max(1, Number(searchParams.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const { where, params } = buildWhere(searchParams);
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT a.id, a.action, a.target, a.created_at, a.metadata_json, u.email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <form className="flex gap-2 text-sm my-3">
        <input name="action" placeholder="action" defaultValue={searchParams.action ?? ""} className="border px-2" />
        <input name="user_id" placeholder="user_id" defaultValue={searchParams.user_id ?? ""} className="border px-2" />
        <input name="date_from" type="date" defaultValue={searchParams.date_from ?? ""} className="border px-2" />
        <input name="date_to"   type="date" defaultValue={searchParams.date_to ?? ""}   className="border px-2" />
        <button type="submit" className="px-3 py-1 bg-slate-900 text-white rounded">Filter</button>
      </form>
      <table data-testid="audit-table" className="text-sm">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toISOString()}</td>
              <td>{r.email ?? "—"}</td>
              <td>{r.action}</td>
              <td>{r.target ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

**Step 3: Test green, commit**

```bash
pnpm --filter web test:int admin-audit-page.int.test.ts
git add apps/web/app/admin/audit/ apps/web/test/admin-audit-page.int.test.ts
git commit -m "feat: /admin/audit page with action/user/date filters (#62)"
```

---

## Task 7: Nav — add Ingestion entry

**Files:**
- Modify: `apps/web/app/_components/nav.tsx`
- Modify: existing nav test (or create `apps/web/test/nav.test.tsx`)

**Step 1: Edit `ROW2_ADMIN`**

```ts
const ROW2_ADMIN = [
  { href: "/admin/users",     label: "Users" },
  { href: "/admin/ingestion", label: "Ingestion" },
  { href: "/admin/audit",     label: "Audit" },
];
```

**Step 2: Add/extend nav test** that asserts admin session renders `Ingestion` link with `href="/admin/ingestion"` and operator/viewer do not.

**Step 3: Run, commit**

```bash
pnpm --filter web test nav
git add apps/web/app/_components/nav.tsx apps/web/test/nav.test.tsx
git commit -m "feat: admin nav adds /admin/ingestion entry (#62)"
```

---

## Task 8: Caddyfile.acme — HSTS + CSP headers

**Files:**
- Modify: `caddy/Caddyfile.acme`

**Step 1: Add header block inside the site block**

```
header {
  Strict-Transport-Security "max-age=300"
  Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  X-Content-Type-Options "nosniff"
  Referrer-Policy "strict-origin-when-cross-origin"
  -Server
}
```

**Step 2: Validate with `caddy validate`**

Run: `docker run --rm -v "$PWD/caddy:/etc/caddy" caddy:2 caddy validate --config /etc/caddy/Caddyfile.acme`
Expected: `Valid configuration`.

**Step 3: Commit**

```bash
git add caddy/Caddyfile.acme
git commit -m "feat: Caddyfile.acme sets HSTS (max-age=300) and baseline CSP (#62)"
```

---

## Task 9: Ingestor healthcheck script + compose wiring

**Files:**
- Create: `apps/ingestor/scripts/healthcheck.ts`
- Modify: `apps/ingestor/tsconfig.json` (include `scripts/`)
- Modify: `apps/ingestor/package.json` (new `build` output implicitly picks `scripts/`)
- Modify: `docker-compose.yml` (add `healthcheck:` to `ingestor`, switch `web.depends_on.ingestor.condition` to `service_healthy`)
- Create: `apps/ingestor/test/healthcheck.int.test.ts`

**Step 1: Failing test**

```ts
// spawn the compiled healthcheck with DATABASE_URL pointing at a testcontainer pg
// scenario a: no rows → exit 0
// scenario b: last = succeeded → exit 0
// scenario c: last = running → exit 0
// scenario d: last = failed → exit 1
// scenario e: bad DATABASE_URL → exit 1
```

**Step 2: Implement script**

```ts
// apps/ingestor/scripts/healthcheck.ts
import pg from "pg";
const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM ingestion_runs ORDER BY started_at DESC LIMIT 1`
    );
    const status = rows[0]?.status;
    if (!status || status === "succeeded" || status === "running") process.exit(0);
    process.stderr.write(`unhealthy: last status=${status}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`unhealthy: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
  }
}
main();
```

**Step 3: Update `tsconfig.json`**

Add `"scripts/**/*.ts"` to `include`. Build output lands at `dist/scripts/healthcheck.js`.

**Step 4: Edit `docker-compose.yml`**

Under `services.ingestor`:
```yaml
    healthcheck:
      test: ["CMD", "node", "dist/scripts/healthcheck.js"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 90s
```

Under `services.web.depends_on.ingestor`:
```yaml
      condition: service_healthy
```

**Step 5: Verify**

Run: `docker compose config` — expect valid YAML, no warnings.
Run: `pnpm --filter ingestor build && pnpm --filter ingestor test healthcheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/ingestor/scripts/healthcheck.ts apps/ingestor/tsconfig.json \
        apps/ingestor/test/healthcheck.int.test.ts docker-compose.yml
git commit -m "feat: ingestor healthcheck; web depends_on service_healthy (#62)"
```

---

## Task 10: Ingestor ESLint — replace placeholder

**Files:**
- Create: `apps/ingestor/eslint.config.mjs`
- Modify: `apps/ingestor/package.json` (`lint` script + devDeps)

**Step 1: Mirror web's config**

Copy structure from `apps/web/eslint.config.*`. Ensure typescript-eslint, node globals, ignores `dist/`.

**Step 2: Add devDeps**

```bash
pnpm --filter ingestor add -D eslint typescript-eslint @eslint/js globals
```

**Step 3: Update `package.json`**

```json
"lint": "eslint ."
```

**Step 4: Run lint**

Run: `pnpm --filter ingestor lint`
Expected: no violations, or fix any that surface (likely unused imports). Do not introduce rule overrides to silence; fix.

**Step 5: Commit**

```bash
git add apps/ingestor/eslint.config.mjs apps/ingestor/package.json pnpm-lock.yaml
git commit -m "build: wire real ESLint for ingestor (#62)"
```

---

## Task 11: RBAC contract test — admin routes 403/200 matrix

**Files:**
- Create: `apps/web/test/admin-rbac.int.test.ts`

**Step 1: Write table-driven test**

```ts
const ROUTES: Array<{ path: string; method: "GET" | "POST" }> = [
  { path: "/api/admin/users",    method: "GET"  },
  { path: "/api/admin/users",    method: "POST" },
  { path: "/api/ingestion/run",  method: "POST" },
  { path: "/admin/users",        method: "GET"  },
  { path: "/admin/ingestion",    method: "GET"  },
  { path: "/admin/audit",        method: "GET"  },
];

describe.each(ROUTES)("$method $path RBAC", ({ path, method }) => {
  it("403 for viewer", async () => {
    const r = await fetchAs(env, asViewer, path, { method });
    expect(r.status).toBe(403);
  });
  it("403 for operator", async () => {
    const r = await fetchAs(env, asOperator, path, { method });
    expect(r.status).toBe(403);
  });
  it("admin: not 403", async () => {
    const r = await fetchAs(env, asAdmin, path, { method });
    expect([200, 201, 400]).toContain(r.status); // 400 acceptable for POSTs missing body
  });
});
```

**Step 2: Run, commit**

```bash
pnpm --filter web test:int admin-rbac.int.test.ts
git add apps/web/test/admin-rbac.int.test.ts
git commit -m "test: contract test admin RBAC (403 non-admin, 2xx admin) (#62)"
```

---

## Task 12: Dev-page gating contract test

**Files:**
- Create: `apps/web/test/dev-gating.int.test.ts`

The middleware already gates; this locks it in.

**Step 1: Test**

```ts
// spawn `next start` with NODE_ENV=production, then hit /design-preview and /graph-preview
// expect 404. (Uses existing harness pattern — or use fetchAs against already-running test server if NODE_ENV=production there.)
```

If the existing int-env always runs with `NODE_ENV=test`, spin a second `next start` child process for this test only (expensive but contained); reuse `helpers/spawn-next-prod.ts` if one exists, else create minimal helper.

**Step 2: Commit**

```bash
git add apps/web/test/dev-gating.int.test.ts apps/web/test/helpers/spawn-next-prod.ts
git commit -m "test: /design-preview and /graph-preview return 404 in production (#62)"
```

---

## Task 13: ADRs

**Files:**
- Create: `docs/decisions/0002-ingestion-trigger-mechanism.md`
- Create: `docs/decisions/0003-hsts-rollout.md`

**Step 1: Write ADR 0002**

Template mirroring `docs/decisions/0001-auth-stack.md`:
- Context: AC needs a real ingest trigger.
- Decision: DB `ingestion_triggers` table + `FOR UPDATE SKIP LOCKED` claim in tickCron.
- Consequences: 60s latency bound to new runs; single-writer assumption holds.
- Rollback: drop table, revert API to 501, rely on nightly cron.

**Step 2: Write ADR 0003**

- Context: Caddyfile.acme needs HSTS but HSTS is irreversible.
- Decision: `max-age=300` initial; bump to `31536000` after 7 clean days.
- Consequences: 5-minute window if we misroute; future preload is a separate decision.
- Rollback: serve `max-age=0` for the current cache window, then remove header.

**Step 3: Commit**

```bash
git add docs/decisions/0002-ingestion-trigger-mechanism.md docs/decisions/0003-hsts-rollout.md
git commit -m "docs: ADRs for ingestion-trigger mechanism and HSTS rollout (#62)"
```

---

## Task 14: E2E — admin run-now golden path

**Files:**
- Create: `apps/web/e2e/admin-ingestion.spec.ts`

**Step 1: Playwright spec**

Login as admin (via existing `e2e/helpers/login.ts`), navigate to `/admin/ingestion`, click `[data-testid=run-now-button]`, assert `[data-testid=run-now-status]` eventually reads `succeeded`. Requires a real ingestor running against the fixture — may be flaky; wrap in `test.slow()` and use `expect.poll` with a 60s timeout.

**Step 2: Run**

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
PLAYWRIGHT_BASE_URL=http://localhost pnpm --filter web test:e2e admin-ingestion
```

**Step 3: Commit**

```bash
git add apps/web/e2e/admin-ingestion.spec.ts
git commit -m "test: e2e golden path for admin Run now (#62)"
```

---

## Task 15: CLAUDE.md pitfalls

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Append pitfalls**

- Don't match on `ingestion_runs.status='success'` — the column value is `'succeeded'`. Healthcheck and UI must match accordingly (see `apps/ingestor/src/runs.ts`).
- Don't bump Caddy HSTS `max-age` past 300 in the same PR as the initial rollout; follow ADR 0003's 7-day-clean escalation procedure.
- Don't claim ingestion triggers outside `tickCron` — the existing `hasRunningRun` mutex is the only coordination point; bypassing it races against the nightly cron.
- Don't add admin routes without extending `apps/web/test/admin-rbac.int.test.ts`'s `ROUTES` table — the contract test is the single enforcement point for "every admin route 403s for non-admin".

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md pitfalls for ops hardening slice (#62)"
```

---

## Task 16: Final verification

**Step 1:** `pnpm -r typecheck` — PASS all workspaces.
**Step 2:** `pnpm -r lint` — PASS (now including ingestor).
**Step 3:** `pnpm --filter ingestor test` — PASS.
**Step 4:** `pnpm --filter web test && pnpm --filter web test:int` — PASS.
**Step 5:** `docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait` — web becomes healthy only AFTER ingestor becomes healthy.
**Step 6:** `pnpm --filter web test:e2e` — PASS.
**Step 7:** `gh pr create` per issues-to-complete Phase 6.

---

## Acceptance criteria traceability

| AC | Task(s) |
|----|---------|
| `POST /api/ingestion/run` triggers + audit + returns id | 1, 4 |
| `/admin/ingestion` page with Run now + recent runs | 5 |
| `/admin/audit` page with filters | 6 |
| Admin nav entries gated by role | 7 |
| Ingestor healthcheck based on last run | 9 |
| `web.depends_on.ingestor.condition: service_healthy` | 9 |
| HSTS + CSP in Caddyfile.acme + ADR | 8, 13 |
| Ingestor real ESLint | 10 |
| RBAC contract test (admin 403/200 matrix) | 11 |
| `/design-preview` + `/graph-preview` 404 in prod | 12 (middleware already implements; test locks it in) |
| ADRs for trigger + HSTS | 13 |
