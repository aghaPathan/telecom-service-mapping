import { z } from "zod";

/**
 * Env-driven ingestor configuration. Fail-fast at startup so the process
 * exits with a clear message rather than dying mid-ingest.
 *
 * Required keys — see `.env.example` for documentation:
 *   DATABASE_URL         app Postgres (migrations + ingestion_runs)
 *   DATABASE_URL_SOURCE  source Postgres (read-only; app_lldp)
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 *
 * Optional ClickHouse block (issue #67 — ISIS-cost ingestion). When
 * `CLICKHOUSE_URL` is unset the ingestor degrades gracefully: nightly runs
 * still complete, just without weighted edges. When CLICKHOUSE_URL is set,
 * the other three CH keys (USER, PASSWORD, DATABASE) become required.
 *
 * NEVER log the parsed values — they contain credentials.
 */
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_SOURCE: z.string().min(1),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  INGEST_MODE: z.enum(["full", "smoke"]).default("full"),
  // Cron expression for scheduled runs when INGEST_MODE=full. Ignored in
  // smoke mode and when --once/--dry-run are passed on the CLI.
  INGEST_CRON: z.string().min(1).default("0 2 * * *"),
  // Absolute path to the directory holding hierarchy.yaml + role_codes.yaml.
  // Optional — when absent the ingestor falls back to a path relative to its
  // own source file. Set in docker-compose to a bind-mounted directory.
  RESOLVER_CONFIG_DIR: z.string().optional(),
  // --- ClickHouse (optional; required as a group when CLICKHOUSE_URL is set)
  CLICKHOUSE_URL: z.string().min(1).optional(),
  CLICKHOUSE_USER: z.string().min(1).optional(),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_DATABASE: z.string().min(1).optional(),
  CLICKHOUSE_ISIS_TABLE: z.string().min(1).default("isis_cost"),
  CLICKHOUSE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
  isisTable: string;
  timeoutMs: number;
}

export type IngestorConfig = z.infer<typeof Schema> & {
  clickhouse?: ClickHouseConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestorConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => i.path.join("."))
      .join(", ");
    throw new Error(`Invalid ingestor config: missing/invalid ${missing}`);
  }
  const data = parsed.data;
  let clickhouse: ClickHouseConfig | undefined;
  if (data.CLICKHOUSE_URL) {
    if (!data.CLICKHOUSE_USER || data.CLICKHOUSE_PASSWORD === undefined || !data.CLICKHOUSE_DATABASE) {
      throw new Error(
        "Invalid ingestor config: CLICKHOUSE_URL is set but one or more of CLICKHOUSE_USER/CLICKHOUSE_PASSWORD/CLICKHOUSE_DATABASE is missing",
      );
    }
    clickhouse = {
      url: data.CLICKHOUSE_URL,
      user: data.CLICKHOUSE_USER,
      password: data.CLICKHOUSE_PASSWORD,
      database: data.CLICKHOUSE_DATABASE,
      isisTable: data.CLICKHOUSE_ISIS_TABLE,
      timeoutMs: data.CLICKHOUSE_TIMEOUT_MS,
    };
  }
  return { ...data, clickhouse };
}
