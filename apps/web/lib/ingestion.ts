import { getPool } from "./postgres";
import { getDriver } from "./neo4j";

export type IngestionRun = {
  id: number;
  status: "running" | "succeeded" | "failed";
  skipped: boolean;
  started_at: string;
  finished_at: string | null;
  source_rows_read: number | null;
  graph_nodes_written: number | null;
  graph_edges_written: number | null;
  sites_loaded: number | null;
  services_loaded: number | null;
  error_text: string | null;
};

export type IngestionStatus = {
  latest: IngestionRun | null;
  graph: { devices: number; links: number } | null;
};

type Row = {
  id: number;
  status: IngestionRun["status"];
  skipped: boolean;
  started_at: Date;
  finished_at: Date | null;
  source_rows_read: number | null;
  graph_nodes_written: number | null;
  graph_edges_written: number | null;
  sites_loaded: number | null;
  services_loaded: number | null;
  error_text: string | null;
};

const SELECT_COLUMNS = `
  id, status, skipped, started_at, finished_at,
  source_rows_read,
  graph_nodes_written, graph_edges_written,
  sites_loaded, services_loaded,
  error_text
`;

function rowToRun(r: Row): IngestionRun {
  return {
    id: r.id,
    status: r.status,
    skipped: r.skipped,
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    source_rows_read: r.source_rows_read,
    graph_nodes_written: r.graph_nodes_written,
    graph_edges_written: r.graph_edges_written,
    sites_loaded: r.sites_loaded,
    services_loaded: r.services_loaded,
    error_text: r.error_text,
  };
}

/**
 * Latest real run (skipped overlap rows are filtered out for the UI badge —
 * operators care about the last time the graph actually changed).
 */
export async function getLatestRealRun(): Promise<IngestionRun | null> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM ingestion_runs
      WHERE skipped = false
      ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

/** Last N runs (includes skipped rows) for the history page. */
export async function listRecentRuns(limit = 20): Promise<IngestionRun[]> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT ${SELECT_COLUMNS} FROM ingestion_runs
      ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToRun);
}

async function countNeo4j(
  cypher: string,
): Promise<number> {
  const session = getDriver().session();
  try {
    const res = await session.run(cypher);
    const rec = res.records[0];
    if (!rec) return 0;
    const n = rec.get("n");
    return typeof n === "number" ? n : n.toNumber();
  } finally {
    await session.close();
  }
}

export async function getIngestionStatus(): Promise<IngestionStatus> {
  const latest = await getLatestRealRun();
  let graph: IngestionStatus["graph"] = null;
  try {
    const [devices, links] = await Promise.all([
      countNeo4j("MATCH (d:Device) RETURN count(d) AS n"),
      countNeo4j("MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS n"),
    ]);
    graph = { devices, links };
  } catch {
    // Neo4j unreachable — surface nulls; badge degrades to "—".
  }
  return { latest, graph };
}

export type Freshness = "fresh" | "stale" | "very_stale" | "none";

export function classifyFreshness(
  finishedAt: string | null,
  now: Date = new Date(),
): Freshness {
  if (!finishedAt) return "none";
  const finished = new Date(finishedAt).getTime();
  const ageHours = (now.getTime() - finished) / (1000 * 60 * 60);
  if (ageHours < 36) return "fresh";
  if (ageHours < 72) return "stale";
  return "very_stale";
}

export function formatAge(
  finishedAt: string | null,
  now: Date = new Date(),
): string {
  if (!finishedAt) return "never";
  const finished = new Date(finishedAt).getTime();
  const deltaMs = Math.max(0, now.getTime() - finished);
  const totalMinutes = Math.floor(deltaMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m ago`;
  return `${hours}h ${minutes}m ago`;
}
