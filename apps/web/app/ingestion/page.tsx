import { listRecentRuns, type IngestionRun } from "@/lib/ingestion";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatDuration(run: IngestionRun): string {
  if (!run.finished_at) return "—";
  const ms =
    new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function statusBadge(run: IngestionRun): {
  label: string;
  className: string;
} {
  if (run.skipped) {
    return {
      label: "skipped",
      className: "bg-slate-100 text-slate-700 ring-slate-300",
    };
  }
  if (run.status === "succeeded") {
    return {
      label: "succeeded",
      className: "bg-emerald-100 text-emerald-900 ring-emerald-300",
    };
  }
  if (run.status === "failed") {
    return {
      label: "failed",
      className: "bg-red-100 text-red-900 ring-red-300",
    };
  }
  return {
    label: "running",
    className: "bg-amber-100 text-amber-900 ring-amber-300",
  };
}

export default async function IngestionHistoryPage() {
  let runs: IngestionRun[] = [];
  let error: string | null = null;
  try {
    runs = await listRecentRuns(20);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        Ingestion history
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Last {runs.length} ingest runs. Skipped rows mean the cron fired while a
        prior run was still in flight.
      </p>

      {error ? (
        <p className="mt-6 text-red-600">History unavailable: {error}</p>
      ) : runs.length === 0 ? (
        <p className="mt-6 text-slate-600">No runs yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Source rows</th>
                <th className="px-3 py-2 text-right">Devices</th>
                <th className="px-3 py-2 text-right">Links</th>
                <th className="px-3 py-2 text-right">Services</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {runs.map((r) => {
                const sb = statusBadge(r);
                return (
                  <tr key={r.id} data-testid={`run-${r.id}`}>
                    <td className="px-3 py-2 font-mono text-slate-500">
                      {r.id}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {formatDuration(r)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${sb.className}`}
                      >
                        {sb.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.source_rows_read ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.graph_nodes_written ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.graph_edges_written ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.services_loaded ?? "—"}
                    </td>
                    <td
                      className="px-3 py-2 text-red-700"
                      title={r.error_text ?? ""}
                    >
                      {r.error_text
                        ? r.error_text.slice(0, 60) +
                          (r.error_text.length > 60 ? "…" : "")
                        : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
