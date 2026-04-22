import Link from "next/link";
import {
  classifyFreshness,
  formatAge,
  getIngestionStatus,
  type Freshness,
} from "@/lib/ingestion";

const COLOR: Record<Freshness, string> = {
  fresh: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  stale: "bg-amber-100 text-amber-900 ring-amber-300",
  very_stale: "bg-red-100 text-red-900 ring-red-300",
  none: "bg-slate-100 text-slate-700 ring-slate-300",
};

export async function FreshnessBadge() {
  let freshness: Freshness = "none";
  let label = "No ingest yet";
  try {
    const { latest, graph } = await getIngestionStatus();
    const finishedAt = latest?.finished_at ?? null;
    freshness = classifyFreshness(finishedAt);
    if (latest && finishedAt) {
      const devices = graph?.devices ?? latest.graph_nodes_written ?? 0;
      const links = graph?.links ?? latest.graph_edges_written ?? 0;
      label = `Last refresh: ${formatAge(finishedAt)} · ${devices} devices · ${links} links`;
    }
  } catch {
    // Postgres/Neo4j unreachable — keep the "No ingest yet" fallback so the
    // header still renders and the rest of the page is usable.
  }

  return (
    <Link
      href="/ingestion"
      data-testid="freshness-badge"
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset hover:opacity-90 ${COLOR[freshness]}`}
    >
      {label}
    </Link>
  );
}
