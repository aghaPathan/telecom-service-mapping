import { requireRole } from "@/lib/rbac";
import { listIsolations, parseIsolationsQuery } from "@/lib/isolations";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function IsolationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("viewer");
  const q = parseIsolationsQuery(searchParams as Record<string, unknown>);
  const rows = await listIsolations(q);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Isolations
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Devices present in inventory but not currently reachable via LLDP.
        Neighbor count reflects the number of recorded connected devices at the
        last isolation load.
      </p>
      <form
        className="mt-6 flex flex-wrap items-end gap-4 rounded-md border border-slate-200 bg-white p-3 text-sm ring-1 ring-slate-100"
        method="get"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Device
          </span>
          <input
            type="text"
            name="device"
            defaultValue={q.device ?? ""}
            placeholder="Device name contains…"
            aria-label="Filter by device name"
            className="w-48 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Vendor
          </span>
          <input
            type="text"
            name="vendor"
            defaultValue={q.vendor ?? ""}
            placeholder="Vendor"
            aria-label="Filter by vendor"
            className="w-32 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="submit"
          className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
        >
          Filter
        </button>
      </form>
      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-600">No isolations recorded.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <th scope="col" className="py-2 pr-4">
                  Device
                </th>
                <th scope="col" className="py-2 pr-4">
                  Vendor
                </th>
                <th scope="col" className="py-2 pr-4">
                  Data source
                </th>
                <th scope="col" className="py-2 pr-4">
                  Neighbors
                </th>
                <th scope="col" className="py-2">
                  Last load
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.device_name} className="hover:bg-slate-50">
                  <td className="py-2 pr-4">
                    <a
                      href={`/device/${encodeURIComponent(r.device_name)}`}
                      className="text-sky-700 hover:underline"
                    >
                      {r.device_name}
                    </a>
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {r.vendor ?? "—"}
                  </td>
                  <td className="py-2 pr-4 text-slate-700">
                    {r.data_source ?? "—"}
                  </td>
                  <td
                    className="py-2 pr-4 text-slate-700"
                    title={r.connected_nodes.join(", ")}
                  >
                    {r.neighbor_count}
                  </td>
                  <td className="py-2 text-slate-700">
                    {r.load_dt instanceof Date
                      ? r.load_dt.toISOString().slice(0, 10)
                      : String(r.load_dt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
