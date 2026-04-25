import type { Pool } from "pg";
import cron from "node-cron";
import { log } from "./logger.js";
import { hasRunningRun, recordSkip } from "./runs.js";
import {
  claimNextTrigger,
  attachRunToTrigger,
  type TriggerFlavor,
} from "./triggers.js";

/**
 * Signature of the run callback injected into `tickCron`. Receives the
 * claimed trigger's flavor (defaults to `'full'` when there is no pending
 * trigger — i.e. the nightly cron tick).
 */
export type CronRunFn = (flavor: TriggerFlavor) => Promise<number | null>;

export type TickOutcome =
  | { action: "ran"; runId: number | null; triggerId: number | null }
  | { action: "skipped"; reason: string; runId: number }
  | { action: "errored"; error: string };

/**
 * One tick of the scheduler. Pure decision logic — `runFn` is injected so
 * unit tests can seed pg state and assert the branch taken without starting
 * real Neo4j / source connections.
 *
 * `runFn` returns the `ingestion_runs.id` it wrote (or null for a no-op).
 *
 * Decision:
 *   - a row with status='running' exists  → record a skip row + log, no runFn,
 *                                           pending trigger (if any) stays
 *                                           unclaimed so the next tick picks it up
 *   - otherwise                           → claim oldest pending trigger (if
 *                                           any), invoke runFn, attach runId to
 *                                           the claimed trigger. Errors are
 *                                           surfaced but NOT rethrown (cron
 *                                           must keep ticking).
 */
export async function tickCron(
  pool: Pool,
  runFn: CronRunFn,
): Promise<TickOutcome> {
  if (await hasRunningRun(pool)) {
    const reason = "prior run still in flight";
    const runId = await recordSkip(pool, reason);
    log("warn", "ingest_skipped_overlap", { runId, reason });
    return { action: "skipped", reason, runId };
  }
  const trigger = await claimNextTrigger(pool);
  try {
    const flavor: TriggerFlavor = trigger?.flavor ?? "full";
    const runId = await runFn(flavor);
    if (runId !== null && trigger) {
      await attachRunToTrigger(pool, trigger.id, runId);
    }
    return {
      action: "ran",
      runId,
      triggerId: trigger?.id ?? null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("error", "cron_run_failed", { error, triggerId: trigger?.id ?? null });
    return { action: "errored", error };
  }
}

/**
 * Start a long-lived cron scheduler. Returns a handle with a `stop()` for
 * tests / graceful shutdown.
 */
export function startScheduler(opts: {
  cronExpr: string;
  pool: Pool;
  runFn: CronRunFn;
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
