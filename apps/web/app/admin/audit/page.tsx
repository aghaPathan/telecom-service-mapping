import { requireRole } from "@/lib/rbac";
import { getPool } from "@/lib/postgres";

export const dynamic = "force-dynamic";

type Row = {
  id: number;
  action: string;
  target: string | null;
  at: string;
  email: string | null;
};

type SP = {
  action?: string;
  user_id?: string;
  date_from?: string;
  date_to?: string;
  page?: string;
};

function buildWhere(sp: SP) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (sp.action) {
    params.push(sp.action);
    clauses.push(`a.action = $${params.length}`);
  }
  if (sp.user_id) {
    params.push(sp.user_id);
    clauses.push(`a.user_id = $${params.length}`);
  }
  if (sp.date_from) {
    params.push(sp.date_from);
    clauses.push(`a.at >= $${params.length}`);
  }
  if (sp.date_to) {
    params.push(sp.date_to);
    clauses.push(`a.at < $${params.length}`);
  }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireRole("admin");
  const pageNum = Math.max(1, Number(searchParams.page) || 1);
  const limit = 20;
  const offset = (pageNum - 1) * limit;
  const { where, params } = buildWhere(searchParams);
  // `limit` is a hardcoded constant and `offset` is derived from a
  // `Math.max`-clamped `Number(searchParams.page)` so both are safe
  // integers. If you ever make either configurable from user input,
  // parameterize them instead of interpolating.
  const { rows } = await getPool().query<Row>(
    `SELECT a.id, a.action, a.target, a.at, u.email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.at DESC
       LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <form className="flex gap-2 text-sm" data-testid="audit-filters">
        <input
          name="action"
          placeholder="action"
          defaultValue={searchParams.action ?? ""}
          className="border px-2"
        />
        <input
          name="user_id"
          placeholder="user_id"
          defaultValue={searchParams.user_id ?? ""}
          className="border px-2"
        />
        <input
          name="date_from"
          type="date"
          defaultValue={searchParams.date_from ?? ""}
          className="border px-2"
        />
        <input
          name="date_to"
          type="date"
          defaultValue={searchParams.date_to ?? ""}
          className="border px-2"
        />
        <button
          type="submit"
          className="px-3 py-1 bg-slate-900 text-white rounded"
        >
          Filter
        </button>
      </form>
      <table data-testid="audit-table" className="text-sm">
        <thead>
          <tr>
            <th className="text-left pr-3">When</th>
            <th className="text-left pr-3">Who</th>
            <th className="text-left pr-3">Action</th>
            <th className="text-left">Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="audit-row">
              <td className="pr-3">{new Date(r.at).toISOString()}</td>
              <td className="pr-3">{r.email ?? "—"}</td>
              <td className="pr-3">{r.action}</td>
              <td>{r.target ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
