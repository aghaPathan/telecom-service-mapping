import { requireRole } from "@/lib/rbac";
import {
  parseDeviceListQuery,
  runDeviceList,
  type DeviceListQuery,
  type DeviceListResult,
} from "@/lib/device-list";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const COLUMNS = ["name", "role", "level", "site", "vendor", "fanout"] as const;

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="analytics-error"
    >
      {message}
    </div>
  );
}

function Header({ subtitle }: { subtitle?: string }) {
  return (
    <div>
      <h1
        className="text-2xl font-semibold tracking-tight text-slate-900"
        data-testid="analytics-page-heading"
      >
        Top devices by fan-out
      </h1>
      {subtitle && (
        <p className="mt-1 text-sm text-slate-600" data-testid="analytics-subtitle">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FilterForm({
  role,
  limit,
}: {
  role: string;
  limit: number;
}) {
  return (
    <form
      method="get"
      action="/analytics"
      className="mt-6 flex flex-wrap items-end gap-4 rounded-md border border-slate-200 bg-white p-3 text-sm ring-1 ring-slate-100"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Role
        </span>
        <input
          type="text"
          name="role"
          defaultValue={role}
          placeholder="e.g. RAN, GPON"
          className="w-40 rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Limit
        </span>
        <input
          type="number"
          name="limit"
          min="1"
          max="200"
          defaultValue={limit}
          className="w-24 rounded border border-slate-300 px-2 py-1"
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

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  await requireRole("viewer");

  // Drop undefined values so Zod defaults apply, and coerce array params to first value.
  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined) continue;
    input[k] = Array.isArray(v) ? (v as string[])[0]! : v;
  }
  // Persist-in-URL values for the form (raw user input, not yet parsed).
  const rawRole = typeof input.role === "string" ? input.role : "";
  const rawLimit = typeof input.limit === "string" ? Number(input.limit) : 20;

  let q: DeviceListQuery | null = null;
  let errMsg: string | null = null;
  try {
    q = parseDeviceListQuery({ ...input, mode: "byFanout" });
  } catch (err) {
    errMsg = err instanceof Error ? err.message : "Invalid query.";
  }

  if (!q) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header />
        <FilterForm role={rawRole} limit={Number.isFinite(rawLimit) ? rawLimit : 20} />
        <div className="mt-6">
          <ErrorPanel message={errMsg ?? "Invalid query."} />
        </div>
      </main>
    );
  }

  // Narrow the union: we forced mode=byFanout above.
  if (q.mode !== "byFanout") {
    // Defensive — parse forces mode=byFanout, so this is unreachable.
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header />
        <FilterForm role={rawRole} limit={20} />
        <div className="mt-6">
          <ErrorPanel message="Unexpected query mode." />
        </div>
      </main>
    );
  }

  let result: DeviceListResult;
  try {
    result = await runDeviceList(q);
  } catch (err) {
    log("error", "analytics_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      role: q.role,
      limit: q.limit,
    });
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header />
        <FilterForm role={q.role ?? ""} limit={q.limit} />
        <div className="mt-6">
          <ErrorPanel message="Analytics unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref =
    `/api/devices/list/csv?mode=byFanout&limit=${q.limit}` +
    (q.role ? `&role=${encodeURIComponent(q.role)}` : "") +
    `&sort=${q.sort}&dir=${q.dir}`;

  const carryParams: Record<string, string | undefined> = {
    role: q.role,
    limit: String(q.limit),
  };

  const subtitle = `${result.total.toLocaleString()} shown (limit ${q.limit})`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header subtitle={subtitle} />
      <FilterForm role={q.role ?? ""} limit={q.limit} />
      <div className="mt-6">
        <RoleFilteredTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={q.sort}
          dir={q.dir}
          baseHref="/analytics"
          carryParams={carryParams}
          csvHref={csvHref}
          columns={COLUMNS}
        />
      </div>
    </main>
  );
}
