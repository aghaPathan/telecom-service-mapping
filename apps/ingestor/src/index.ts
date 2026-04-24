import neo4j, { type Driver } from "neo4j-driver";
import pg from "pg";
import { migrate, getPool, closePool } from "@tsm/db";

// pg is CJS; destructure Pool from the default export (same pattern as
// packages/db/src/index.ts). Dynamic `await import("pg")` + named destructure
// silently yields undefined because Node's ESM named-export synthesis for
// this package does not expose `Pool`.
const { Pool } = pg;
import { log } from "./logger.js";
import { loadConfig, type IngestorConfig } from "./config.js";
import { readActiveLldpRows } from "./source/lldp.js";
import { readSites } from "./source/sites.js";
import { readServices } from "./source/services.js";
import { readIsolations } from "./source/isolations.js";
import { writeIsolations } from "./isolations-writer.js";
import { dedupLldpRows } from "./dedup.js";
import { buildServicesGraph } from "./services.js";
import { writeGraph, type SitePortalRow } from "./graph/writer.js";
import { startRun, finishRun } from "./runs.js";
import { startScheduler, tickCron } from "./cron.js";
import {
  loadResolverConfigFromDir,
  resolveRole,
  summarizeUnresolved,
  type ResolverConfig,
} from "./resolver.js";
import { loadSitesYaml, defaultSitesYamlPath } from "./sites-coords.js";
import path from "node:path";

export type RunIngestOpts = {
  dryRun: boolean;
  config?: IngestorConfig;
  /**
   * Override the directory that holds `hierarchy.yaml` and `role_codes.yaml`.
   * Defaults to `<repo_root>/config`. Integration tests pass a tmp dir.
   */
  resolverConfigDir?: string;
};

function defaultConfigDir(): string {
  // When running under tsx (tests/dev), import.meta.url points at src/.
  // When running the compiled artifact, it points at dist/. In either case
  // going up three levels lands in the repo root.
  const here = new URL(import.meta.url).pathname;
  return path.resolve(path.dirname(here), "..", "..", "..", "config");
}

export type RunIngestResult = {
  runId: number;
  dryRun: boolean;
  sourceRows: number;
  dropped: { null_b: number; self_loop: number; anomaly: number };
  warnings: unknown[];
  graph: {
    nodes: number;
    edges: number;
    sites: number;
    services: number;
    terminate_edges: number;
    located_at_edges: number;
    protected_by_edges: number;
  };
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
 *   4. read LLDP + sites + services; dedup LLDP; build services graph
 *   5. dry-run: log planned counts, finishRun succeeded w/ dry_run=true, return
 *      non-dry:  writeGraph, finishRun succeeded w/ counts
 *   6. on error:  finishRun failed w/ error_text, rethrow
 */
export async function runIngest(opts: RunIngestOpts): Promise<RunIngestResult> {
  const config = opts.config ?? loadConfig();

  await migrate(config.DATABASE_URL);
  const pool = getPool(config.DATABASE_URL);

  // CI / tracer-bullet mode: migrations applied, one seed Device written, no
  // source read. Preserves the #2 tracer assertion (Devices in graph: 1) when
  // the source DB is absent.
  if (config.INGEST_MODE === "smoke") {
    log("info", "ingestor_smoke_mode", {});
    const seedDriver = neo4j.driver(
      config.NEO4J_URI,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
      { connectionAcquisitionTimeout: 10_000 },
    );
    try {
      await waitForNeo4j(seedDriver);
      const session = seedDriver.session();
      try {
        await session.run(
          "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
        );
        await session.run(
          "MERGE (d:Device {name: $name}) ON CREATE SET d.created_at = timestamp()",
          { name: "seed-01" },
        );
      } finally {
        await session.close();
      }
    } finally {
      await seedDriver.close();
      await closePool();
    }
    return {
      runId: 0,
      dryRun: opts.dryRun,
      sourceRows: 0,
      dropped: { null_b: 0, self_loop: 0, anomaly: 0 },
      warnings: [],
      graph: {
        nodes: 1,
        edges: 0,
        sites: 0,
        services: 0,
        terminate_edges: 0,
        located_at_edges: 0,
        protected_by_edges: 0,
      },
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

    const rawSites = await readSites(config.DATABASE_URL_SOURCE);
    log("info", "sites_read", { count: rawSites.length });

    const { services: rawServices, deviceCids } = await readServices(
      config.DATABASE_URL_SOURCE,
    );
    log("info", "services_read", {
      services: rawServices.length,
      device_cids: deviceCids.length,
    });

    const svcGraph = buildServicesGraph(rawServices, deviceCids);
    log("info", "services_built", {
      services: svcGraph.services.length,
      terminates: svcGraph.terminates.length,
      protections: svcGraph.protections.length,
      dropped: svcGraph.dropped,
    });

    // Load role/hierarchy config fresh every run (per PRD: edit YAML, re-ingest).
    const resolverCfg: ResolverConfig = loadResolverConfigFromDir(
      opts.resolverConfigDir
        ?? config.RESOLVER_CONFIG_DIR
        ?? defaultConfigDir(),
    );
    let unresolvedCount = 0;
    const allResolved: import("./resolver.js").ResolvedRole[] = [];
    for (const d of dedup.devices) {
      const resolved = resolveRole(
        { name: d.name, type_code: d.type_code },
        resolverCfg,
      );
      d.role = resolved.role;
      d.level = resolved.level;
      d.tags = resolved.tags;
      allResolved.push(resolved);
      if (resolved.level === resolverCfg.hierarchy.unknown_level) {
        unresolvedCount += 1;
      }
    }
    const topUnresolved = summarizeUnresolved(allResolved, 20);
    log("info", "roles_resolved", {
      devices: dedup.devices.length,
      unresolved: unresolvedCount,
      top_unresolved_tokens: topUnresolved,
    });
    // Append rollup warning when there are unresolved tokens — gives data-quality
    // stewards visibility into trending resolver gaps via warnings_json.
    const resolverWarnings: unknown[] = topUnresolved.length > 0
      ? [{ kind: "unresolved_role_tokens", topN: 20, entries: topUnresolved }]
      : [];

    // Isolations stage: full-refresh from source `app_isolations` → target
    // `isolations` table. Skipped in dry-run (no writes) and smoke mode
    // (smoke returns early before this point). Non-fatal: a failure logs a
    // warning but does NOT fail the overall ingest.
    if (!opts.dryRun) {
      try {
        const isolationRows = await readIsolations(config.DATABASE_URL_SOURCE);
        await writeIsolations(pool, isolationRows);
        log("info", "isolations_written", { count: isolationRows.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", "isolations_stage_failed", { error: msg });
      }
    }

    const sites: SitePortalRow[] = rawSites.map((s) => ({
      name: s.site_name,
      category: s.category,
      url: s.site_url,
    }));

    if (opts.dryRun) {
      await finishRun(pool, runId, {
        status: "succeeded",
        source_rows_read: rows.length,
        rows_dropped_null_b: dedup.dropped.null_b,
        rows_dropped_self_loop: dedup.dropped.self_loop,
        rows_dropped_anomaly: dedup.dropped.anomaly,
        graph_nodes_written: 0,
        graph_edges_written: 0,
        sites_loaded: 0,
        services_loaded: 0,
        terminate_edges: 0,
        located_at_edges: 0,
        protected_by_edges: 0,
        warnings: [...dedup.warnings, ...resolverWarnings],
      });
      log("info", "run_finished_dry_run", { runId });
      return {
        runId,
        dryRun: true,
        sourceRows: rows.length,
        dropped: dedup.dropped,
        warnings: dedup.warnings,
        graph: {
          nodes: 0,
          edges: 0,
          sites: 0,
          services: 0,
          terminate_edges: 0,
          located_at_edges: 0,
          protected_by_edges: 0,
        },
      };
    }

    driver = neo4j.driver(
      config.NEO4J_URI,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
      { connectionAcquisitionTimeout: 10_000 },
    );
    await waitForNeo4j(driver);
    const resolverDir =
      opts.resolverConfigDir
        ?? config.RESOLVER_CONFIG_DIR
        ?? defaultConfigDir();
    const siteCoords = loadSitesYaml(defaultSitesYamlPath(resolverDir));
    log("info", "site_coords_loaded", { count: siteCoords.size });

    const counts = await writeGraph(
      driver,
      {
        devices: dedup.devices,
        links: dedup.links,
        sites,
        siteCoords,
        services: svcGraph.services,
        terminates: svcGraph.terminates,
        protections: svcGraph.protections,
      },
      resolverCfg,
    );
    log("info", "graph_written", counts);

    await finishRun(pool, runId, {
      status: "succeeded",
      source_rows_read: rows.length,
      rows_dropped_null_b: dedup.dropped.null_b,
      rows_dropped_self_loop: dedup.dropped.self_loop,
      rows_dropped_anomaly: dedup.dropped.anomaly,
      graph_nodes_written: counts.nodes,
      graph_edges_written: counts.edges,
      sites_loaded: counts.sites,
      services_loaded: counts.services,
      terminate_edges: counts.terminate_edges,
      located_at_edges: counts.located_at_edges,
      protected_by_edges: counts.protected_by_edges,
      warnings: [...dedup.warnings, ...resolverWarnings],
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

function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  once: boolean;
} {
  return {
    dryRun: argv.includes("--dry-run"),
    once: argv.includes("--once") || argv.includes("--dry-run"),
  };
}

/**
 * Long-lived cron mode: an initial run on startup (honouring skip logic),
 * then scheduled ticks via node-cron. Uses a dedicated pg Pool for the skip
 * check so it survives `runIngest`'s own pool lifecycle.
 */
async function runScheduled(): Promise<void> {
  const config = loadConfig();
  const schedulerPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
  });
  let handle: { stop: () => void } | null = null;
  try {
    await migrate(config.DATABASE_URL);
    const runFn = async (): Promise<void> => {
      await runIngest({ dryRun: false, config });
    };
    log("info", "ingestor_cron_mode", { cron: config.INGEST_CRON });
    // Initial run on boot so the graph is populated immediately; the shared
    // tickCron path ensures we still record a skip if another instance is
    // already mid-run (defense in depth).
    await tickCron(schedulerPool, runFn);
    handle = startScheduler({
      cronExpr: config.INGEST_CRON,
      pool: schedulerPool,
      runFn,
    });
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        if (handle) handle.stop();
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    if (handle) handle.stop();
    await schedulerPool.end();
  }
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
  const envMode = process.env.INGEST_MODE ?? "full";

  // One-shot paths: explicit --once/--dry-run, or smoke-mode CI seed.
  // Everything else is long-lived cron.
  const oneShot = opts.once || envMode === "smoke";
  const task = oneShot ? runIngest({ dryRun: opts.dryRun }) : runScheduled();

  task
    .then(() => log("info", "ingestor_done"))
    .catch((err) => {
      log("error", "ingestor_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
