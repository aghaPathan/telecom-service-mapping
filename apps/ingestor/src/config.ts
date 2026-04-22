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
 * NEVER log the parsed values — they contain credentials.
 */
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_SOURCE: z.string().min(1),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  INGEST_MODE: z.enum(["full", "smoke"]).default("full"),
});

export type IngestorConfig = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestorConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => i.path.join("."))
      .join(", ");
    throw new Error(`Invalid ingestor config: missing/invalid ${missing}`);
  }
  return parsed.data;
}
