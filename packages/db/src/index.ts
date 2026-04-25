import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { runner } from "node-pg-migrate";

const { Pool } = pg;
type Pool = pg.Pool;

let pool: Pool | null = null;

export function getPool(databaseUrl?: string): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to obtain a pg pool");
  }
  pool = new Pool({ connectionString });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Resolve the migrations directory relative to the installed package. Works
 * both from source (packages/db/src → ../migrations) and from a deployed
 * vendor tree where `src/` sits next to `migrations/`.
 */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "migrations");
}

export async function migrate(databaseUrl?: string): Promise<void> {
  const connectionString = databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to run migrations");
  }
  await runner({
    databaseUrl: connectionString,
    dir: migrationsDir(),
    migrationsTable: "pgmigrations",
    direction: "up",
    count: Infinity,
    singleTransaction: true,
    schema: "public",
  });
}

export type { Pool };

export {
  parseHostname,
  DEFAULT_HOSTNAME_CONFIG,
  type HostnameParseConfig,
  type ParsedHostname,
} from "./hostname.js";

export {
  TRIGGER_FLAVORS,
  type TriggerFlavor,
  isTriggerFlavor,
} from "./triggers.js";
