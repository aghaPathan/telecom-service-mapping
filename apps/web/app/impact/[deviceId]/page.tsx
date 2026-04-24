import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { parseImpactQuery, runImpact, type ImpactResponse } from "@/lib/impact";
import { RoleBadge } from "@/app/_components/role-badge";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function summaryLine(
  summary: Extract<ImpactResponse, { status: "ok" | "too_large" }>["summary"],
) {
  const byRole = new Map<string, number>();
  for (const g of summary) byRole.set(g.role, (byRole.get(g.role) ?? 0) + g.count);
  return [...byRole.entries()].map(([r, c]) => `${fmt(c)} ${r}`).join(" · ");
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="impact-error"
    >
      {message}
    </div>
  );
}

export default async function ImpactPage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { [k: string]: string | undefined };
}) {
  await requireRole("viewer");
  const name = decodeURIComponent(params.deviceId);

  let parsed;
  try {
    parsed = parseImpactQuery({ device: name, ...searchParams });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid query.";
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6"><ErrorPanel message={msg} /></div>
      </main>
    );
  }

  let result: ImpactResponse;
  try {
    result = await runImpact(parsed);
  } catch (err) {
    log("error", "impact_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      device: name,
    });
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6">
          <ErrorPanel message="Impact unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref =
    `/api/impact/csv?device=${encodeURIComponent(name)}` +
    `&include_transport=${parsed.include_transport}` +
    `&max_depth=${parsed.max_depth}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header name={name} csvHref={result.status !== "start_not_found" ? csvHref : undefined} />
      <FilterForm
        device={name}
        includeTransport={parsed.include_transport}
        maxDepth={parsed.max_depth}
      />
      {result.status === "start_not_found" ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-100"
            data-testid="impact-not-found"
          >
            Device not found: <span className="font-medium">{name}</span>
          </div>
        </div>
      ) : result.status === "too_large" ? (
        <TooLargeView total={result.total} summary={result.summary} csvHref={csvHref} />
      ) : result.total === 0 ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
            data-testid="impact-empty"
          >
            No devices reachable downstream.
          </div>
        </div>
      ) : (
        <OkView result={result} />
      )}
    </main>
  );
}

function Header({ name, csvHref }: { name: string; csvHref?: string }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <Link
          href={`/device/${encodeURIComponent(name)}`}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          ← Back to device detail
        </Link>
        <h1
          className="mt-1 text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="impact-page-name"
        >
          Impact of {name}
        </h1>
      </div>
      {csvHref && (
        <a
          href={csvHref}
          data-testid="impact-csv-link"
          className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Export CSV
        </a>
      )}
    </div>
  );
}

function FilterForm({
  device,
  includeTransport,
  maxDepth,
}: {
  device: string;
  includeTransport: boolean;
  maxDepth: number;
}) {
  return (
    <form
      method="get"
      action={`/impact/${encodeURIComponent(device)}`}
      className="mt-6 flex flex-wrap items-center gap-4 rounded-md border border-slate-200 bg-white p-3 text-sm ring-1 ring-slate-100"
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="include_transport"
          value="true"
          defaultChecked={includeTransport}
          className="h-4 w-4 rounded border-slate-300"
        />
        <span className="text-slate-700">Include transport (MW)</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-slate-700">Max depth</span>
        <input
          type="number"
          name="max_depth"
          min={1}
          max={15}
          defaultValue={maxDepth}
          className="w-16 rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <button
        type="submit"
        className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
      >
        Apply
      </button>
    </form>
  );
}

function SummarySection({
  summary,
}: {
  summary: Extract<ImpactResponse, { status: "ok" | "too_large" }>["summary"];
}) {
  return (
    <section className="mt-6" data-testid="impact-summary">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {summary.map((g) => (
          <div
            key={`${g.level}-${g.role}`}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 ring-1 ring-slate-100"
          >
            <RoleBadge role={g.role} level={g.level} />
            <span className="text-xs text-slate-600">{fmt(g.count)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function OkView({
  result,
}: {
  result: Extract<ImpactResponse, { status: "ok" }>;
}) {
  return (
    <div>
      <p className="mt-6 text-sm text-slate-700" data-testid="impact-count">
        <span className="font-medium">{fmt(result.total)}</span> downstream devices — {summaryLine(result.summary)}
      </p>
      <SummarySection summary={result.summary} />
      <section className="mt-8" data-testid="impact-table">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Affected devices</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Hostname</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Site</th>
                <th className="py-2 pr-3">Vendor</th>
                <th className="py-2 pr-3 text-right">Hops</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((r) => (
                <tr key={r.name}>
                  <td className="py-1.5 pr-3">
                    <Link
                      href={`/device/${encodeURIComponent(r.name)}`}
                      className="text-sky-700 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">
                    <RoleBadge role={r.role} level={r.level} />
                  </td>
                  <td className="py-1.5 pr-3 text-slate-700">{r.site ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-slate-700">{r.vendor ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{r.hops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TooLargeView({
  total,
  summary,
  csvHref,
}: {
  total: number;
  summary: Extract<ImpactResponse, { status: "too_large" }>["summary"];
  csvHref: string;
}) {
  return (
    <div>
      <div
        className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
        data-testid="impact-too-large"
      >
        <p>
          <span className="font-medium">{fmt(total)}</span> downstream devices — too many to render in-page. Use the CSV export below.
        </p>
        <a
          href={csvHref}
          className="mt-3 inline-flex items-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-50"
        >
          Download CSV
        </a>
      </div>
      <SummarySection summary={summary} />
    </div>
  );
}
