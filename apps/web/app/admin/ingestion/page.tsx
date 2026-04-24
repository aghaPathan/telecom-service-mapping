import { requireRole } from "@/lib/rbac";
import { getPool } from "@/lib/postgres";
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
  const { rows } = await getPool().query<RunRow>(
    `SELECT id, status, started_at, finished_at, skipped, error_text
       FROM ingestion_runs
       ORDER BY started_at DESC
       LIMIT 20`,
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
        <thead>
          <tr>
            <th className="text-left pr-3">Id</th>
            <th className="text-left pr-3">Status</th>
            <th className="text-left pr-3">Started</th>
            <th className="text-left pr-3">Finished</th>
            <th className="text-left pr-3">Skipped</th>
            <th className="text-left">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} data-testid="recent-run-row">
              <td className="pr-3">{r.id}</td>
              <td className="pr-3">{r.status}</td>
              <td className="pr-3">{new Date(r.started_at).toISOString()}</td>
              <td className="pr-3">
                {r.finished_at ? new Date(r.finished_at).toISOString() : "—"}
              </td>
              <td className="pr-3">{r.skipped ? "yes" : "no"}</td>
              <td>{r.error_text ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
