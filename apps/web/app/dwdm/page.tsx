import { requireRole } from "@/lib/rbac";
import { listDwdmLinks, type DwdmRow, type ListDwdmFilter } from "@/lib/dwdm";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="dwdm-error"
    >
      {message}
    </div>
  );
}

function pickStr(v: string | string[] | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

function buildCsvHref(filter: ListDwdmFilter): string {
  const qs = new URLSearchParams();
  qs.set("format", "csv");
  if (filter.device_a) qs.set("device_a", filter.device_a);
  if (filter.device_b) qs.set("device_b", filter.device_b);
  if (filter.ring) qs.set("ring", filter.ring);
  if (filter.span_name) qs.set("span_name", filter.span_name);
  return `/api/dwdm?${qs.toString()}`;
}

export default async function DwdmPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("viewer");

  const filter: ListDwdmFilter = {
    device_a: pickStr(searchParams.device_a),
    device_b: pickStr(searchParams.device_b),
    ring: pickStr(searchParams.ring),
    span_name: pickStr(searchParams.span_name),
  };

  let rows: DwdmRow[];
  let resolverFailed = false;
  try {
    rows = await listDwdmLinks(filter);
  } catch (err) {
    log("error", "dwdm_page_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    rows = [];
    resolverFailed = true;
  }

  const csvHref = buildCsvHref(filter);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="dwdm-page-heading"
        >
          DWDM Links
        </h1>
        {!resolverFailed && rows.length > 0 ? (
          <a
            href={csvHref}
            className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            data-testid="dwdm-csv-link"
          >
            Export CSV
          </a>
        ) : null}
      </div>

      <form
        method="get"
        className="mt-6 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="dwdm-filter-form"
      >
        <label className="flex flex-col text-xs font-medium text-slate-700">
          Device A
          <input
            type="text"
            name="device_a"
            defaultValue={filter.device_a ?? ""}
            placeholder="e.g. XX-YYY-CORE-01"
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-700">
          Device B
          <input
            type="text"
            name="device_b"
            defaultValue={filter.device_b ?? ""}
            placeholder="e.g. XX-YYY-AGG-02"
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-700">
          Ring
          <input
            type="text"
            name="ring"
            defaultValue={filter.ring ?? ""}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-700">
          Span name
          <input
            type="text"
            name="span_name"
            defaultValue={filter.span_name ?? ""}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900"
          />
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <button
            type="submit"
            className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800"
          >
            Apply filters
          </button>
        </div>
      </form>

      <div className="mt-6">
        {resolverFailed ? (
          <ErrorPanel message="DWDM list unavailable. Neo4j may be offline — try again in a moment." />
        ) : rows.length === 0 ? (
          <p
            className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600"
            data-testid="dwdm-empty"
          >
            No DWDM links match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table
              className="min-w-full text-sm text-slate-900"
              data-testid="dwdm-table"
            >
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">A name</th>
                  <th className="px-3 py-2 text-left font-medium">A role</th>
                  <th className="px-3 py-2 text-left font-medium">A level</th>
                  <th className="px-3 py-2 text-left font-medium">B name</th>
                  <th className="px-3 py-2 text-left font-medium">B role</th>
                  <th className="px-3 py-2 text-left font-medium">B level</th>
                  <th className="px-3 py-2 text-left font-medium">Ring</th>
                  <th className="px-3 py-2 text-left font-medium">Span name</th>
                  <th className="px-3 py-2 text-left font-medium">SNFN CIDs</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Mobily CIDs
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr
                    key={`${r.a_name}|${r.b_name}|${i}`}
                    data-testid="dwdm-row"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{r.a_name}</td>
                    <td className="px-3 py-2">{r.a_role ?? ""}</td>
                    <td className="px-3 py-2">{r.a_level ?? ""}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.b_name}</td>
                    <td className="px-3 py-2">{r.b_role ?? ""}</td>
                    <td className="px-3 py-2">{r.b_level ?? ""}</td>
                    <td className="px-3 py-2">{r.ring ?? ""}</td>
                    <td className="px-3 py-2">{r.span_name ?? ""}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.snfn_cids.join(" ")}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.mobily_cids.join(" ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
