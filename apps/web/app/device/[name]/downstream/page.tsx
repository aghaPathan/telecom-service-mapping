import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import {
  parseDownstreamQuery,
  runDownstream,
  type DownstreamResponse,
} from "@/lib/downstream";
import type { DeviceRef } from "@/lib/path";
import { RoleBadge } from "@/app/_components/role-badge";
import { SaveViewButton } from "@/app/_components/save-view-button";
import { DownstreamListFilter } from "@/app/device/[name]/downstream/_filter";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="downstream-error"
    >
      {message}
    </div>
  );
}

function groupSummary(result: Extract<DownstreamResponse, { status: "ok" }>) {
  // Collapse by role so the summary line reads "3 CSG · 42 RAN · 10 Customer"
  // rather than splitting across levels.
  const byRole = new Map<string, number>();
  for (const g of result.groups) {
    byRole.set(g.role, (byRole.get(g.role) ?? 0) + g.count);
  }
  const parts: string[] = [];
  for (const [role, count] of byRole) {
    parts.push(`${count} ${role}`);
  }
  return parts.join(" · ");
}

export default async function DownstreamPage({
  params,
  searchParams,
}: {
  params: { name: string };
  searchParams: { [k: string]: string | undefined };
}) {
  const session = await requireRole("viewer");
  const name = decodeURIComponent(params.name);

  let parsed;
  try {
    parsed = parseDownstreamQuery({
      device: name,
      ...searchParams,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Invalid downstream query.";
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6">
          <ErrorPanel message={msg} />
        </div>
      </main>
    );
  }

  let result: DownstreamResponse | null = null;
  try {
    result = await runDownstream(parsed);
  } catch (err) {
    log("error", "downstream_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      device: name,
    });
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Header name={name} />
        <div className="mt-6">
          <ErrorPanel message="Downstream unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref =
    `/api/downstream/csv?device=${encodeURIComponent(name)}` +
    `&include_transport=${parsed.include_transport}` +
    `&max_depth=${parsed.max_depth}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header name={name} csvHref={csvHref} />

      <FilterForm
        device={name}
        includeTransport={parsed.include_transport}
        maxDepth={parsed.max_depth}
      />

      {result.status === "ok" && (
        <div className="mt-2 flex justify-end">
          <SaveViewButton
            role={session.user.role}
            payload={{ kind: "downstream", query: parsed }}
          />
        </div>
      )}

      {result.status === "start_not_found" ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-100"
            data-testid="downstream-not-found"
          >
            Device not found: <span className="font-medium">{name}</span>
          </div>
        </div>
      ) : result.total === 0 ? (
        <div className="mt-8">
          <div
            className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-100"
            data-testid="downstream-empty"
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
          data-testid="downstream-page-name"
        >
          Downstream from {name}
        </h1>
      </div>
      {csvHref && (
        <a
          href={csvHref}
          data-testid="downstream-csv-link"
          className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50"
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
      action={`/device/${encodeURIComponent(device)}/downstream`}
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

function OkView({
  result,
}: {
  result: Extract<DownstreamResponse, { status: "ok" }>;
}) {
  const summary = groupSummary(result);
  const allDevices: DeviceRef[] = result.groups.flatMap((g) => g.devices);
  return (
    <div>
      <p
        className="mt-6 text-sm text-slate-700"
        data-testid="downstream-summary"
      >
        Showing downstream from{" "}
        <span className="font-medium">{result.start.name}</span>:{" "}
        <span className="font-medium">{result.total}</span> devices
        {summary ? ` — ${summary}` : ""}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <aside data-testid="downstream-tree">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Tree
          </h2>
          <div className="mt-3 space-y-4">
            {result.groups.map((g) => (
              <section
                key={`${g.level}-${g.role}`}
                className="rounded-md border border-slate-200 bg-white p-3 ring-1 ring-slate-100"
              >
                <div className="flex items-center gap-2">
                  <RoleBadge role={g.role} level={g.level} />
                  <span className="text-xs text-slate-500">
                    Level {g.level} · {g.count}
                  </span>
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-slate-800">
                  {g.devices.map((d) => (
                    <li
                      key={d.name}
                      className="truncate"
                      data-testid={
                        d.level === 3.5 ? "downstream-mw-row" : undefined
                      }
                    >
                      {d.name}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </aside>

        <section data-testid="downstream-list">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            List
          </h2>
          <div className="mt-3">
            <DownstreamListFilter devices={allDevices} />
          </div>
        </section>
      </div>

    </div>
  );
}
