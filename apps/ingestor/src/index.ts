import neo4j, { type Driver } from "neo4j-driver";
import { migrate, getPool, closePool } from "@tsm/db";
import { log } from "./logger.js";
import { loadConfig, type IngestorConfig } from "./config.js";
import { readActiveLldpRows } from "./source/lldp.js";
import { dedupLldpRows } from "./dedup.js";
import { writeGraph } from "./graph/writer.js";
import { startRun, finishRun } from "./runs.js";

export type RunIngestOpts = {
  dryRun: boolean;
  config?: IngestorConfig;
};

export type RunIngestResult = {
  runId: number;
  dryRun: boolean;
  sourceRows: number;
  dropped: { null_b: number; self_loop: number; anomaly: number };
  warnings: unknown[];
  graph: { nodes: number; edges: number };
};

async function waitForNeo4j(
  driver: Driver,
  attempts = 30,
  delayMs = 2000,
): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await driver.verifyConnectivity();
      log("info", "neo4j_ready", { attempt: i });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      log("warn", "neo4j_not_ready", {
        attempt: i,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Library-form ingest: used by the CLI below and by integration tests.
 *
 * Orchestration:
 *   1. loadConfig() — fail-fast on missing env
 *   2. migrate()    — app pg schema up-to-date
 *   3. startRun()   — ingestion_runs row in 'running'
 *   4. read + dedup source rows
 *   5. dry-run: log planned counts, finishRun succeeded w/ dry_run=true, return
 *      non-dry:  writeGraph, finishRun succeeded w/ counts
 *   6. on error:  finishRun failed w/ error_text, rethrow
 */
export async function runIngest(opts: RunIngestOpts): Promise<RunIngestResult> {
  const config = opts.config ?? loadConfig();

  await migrate(config.DATABASE_URL);
  const pool = getPool(config.DATABASE_URL);

  // CI / tracer-bullet mode: migrations applied, no source read, no Neo4j write.
  // Keeps `service_completed_successfully` green when the source DB is absent.
  if (config.INGEST_MODE === "smoke") {
    log("info", "ingestor_smoke_mode", {});
    await closePool();
    return {
      runId: 0,
      dryRun: opts.dryRun,
      sourceRows: 0,
      dropped: { null_b: 0, self_loop: 0, anomaly: 0 },
      warnings: [],
      graph: { nodes: 0, edges: 0 },
    };
  }

  const runId = await startRun(pool, { dryRun: opts.dryRun });
  log("info", "run_started", { runId, dryRun: opts.dryRun });

  let driver: Driver | null = null;
  try {
    const rows = await readActiveLldpRows(config.DATABASE_URL_SOURCE);
    // SECURITY: do NOT log rows themselves — they contain real hostnames.
    log("info", "source_rows_read", { count: rows.length });

    const dedup = dedupLldpRows(rows);
    log("info", "dedup_complete", {
      devices: dedup.devices.length,
      links: dedup.links.length,
      dropped: dedup.dropped,
      warnings: dedup.warnings.length,
    });

    if (opts.dryRun) {
      await finishRun(pool, runId, {
        status: "succeeded",
        source_rows_read: rows.length,
        rows_dropped_null_b: dedup.dropped.null_b,
        rows_dropped_self_loop: dedup.dropped.self_loop,
        rows_dropped_anomaly: dedup.dropped.anomaly,
        graph_nodes_written: 0,
        graph_edges_written: 0,
        warnings: dedup.warnings,
      });
      log("info", "run_finished_dry_run", { runId });
      return {
        runId,
        dryRun: true,
        sourceRows: rows.length,
        dropped: dedup.dropped,
        warnings: dedup.warnings,
        graph: { nodes: 0, edges: 0 },
      };
    }

    driver = neo4j.driver(
      config.NEO4J_URI,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
      { connectionAcquisitionTimeout: 10_000 },
    );
    await waitForNeo4j(driver);
    const counts = await writeGraph(driver, dedup);
    log("info", "graph_written", counts);

    await finishRun(pool, runId, {
      status: "succeeded",
      source_rows_read: rows.length,
      rows_dropped_null_b: dedup.dropped.null_b,
      rows_dropped_self_loop: dedup.dropped.self_loop,
      rows_dropped_anomaly: dedup.dropped.anomaly,
      graph_nodes_written: counts.nodes,
      graph_edges_written: counts.edges,
      warnings: dedup.warnings,
    });
    log("info", "run_finished", { runId });

    return {
      runId,
      dryRun: false,
      sourceRows: rows.length,
      dropped: dedup.dropped,
      warnings: dedup.warnings,
      graph: counts,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun(pool, runId, { status: "failed", error_text: msg });
    log("error", "run_failed", { runId, error: msg });
    throw err;
  } finally {
    if (driver) await driver.close();
    await closePool();
  }
}

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

// CLI entrypoint — only runs when this file is invoked directly (not imported).
// `import.meta.url` will equal the process.argv[1] file URL when run as the
// entry. Integration tests import `runIngest` and skip this block.
const isCliEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isCliEntry) {
  const opts = parseArgs(process.argv.slice(2));
  runIngest(opts)
    .then(() => log("info", "ingestor_done"))
    .catch((err) => {
      log("error", "ingestor_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
