import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import {
  parseDeviceListQuery,
  runDeviceList,
  type DeviceListResult,
} from "@/lib/device-list";
import { isKnownRole } from "@/lib/role-allowlist";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="summary-error"
    >
      {message}
    </div>
  );
}

export default async function SummaryByRolePage({
  params,
  searchParams,
}: {
  params: { role: string };
  searchParams: { [k: string]: string | undefined };
}) {
  await requireRole("viewer");
  const role = decodeURIComponent(params.role);
  if (!isKnownRole(role)) notFound();

  // Spread searchParams first, then force mode+role so a stray `?mode=byFanout`
  // in the URL can't redirect the discriminated union.
  let q;
  try {
    q = parseDeviceListQuery({ ...searchParams, mode: "byRole", role });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid query.";
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header role={role} />
        <div className="mt-6">
          <ErrorPanel message={msg} />
        </div>
      </main>
    );
  }

  let result: DeviceListResult;
  try {
    result = await runDeviceList(q);
  } catch (err) {
    log("error", "summary_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      role,
    });
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <Header role={role} />
        <div className="mt-6">
          <ErrorPanel message="List unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref =
    `/api/devices/list/csv?mode=byRole&role=${encodeURIComponent(role)}` +
    `&sort=${q.sort}&dir=${q.dir}`;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header role={role} total={result.total} />
      <div className="mt-6">
        <RoleFilteredTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={q.sort}
          dir={q.dir}
          baseHref={`/summary/${encodeURIComponent(role)}`}
          carryParams={{}}
          csvHref={csvHref}
        />
      </div>
    </main>
  );
}

function Header({ role, total }: { role: string; total?: number }) {
  return (
    <div>
      <h1
        className="text-2xl font-semibold tracking-tight text-slate-900"
        data-testid="summary-page-role"
      >
        {role} devices
      </h1>
      {typeof total === "number" && (
        <p className="mt-1 text-sm text-slate-600" data-testid="summary-total">
          {total.toLocaleString()} total
        </p>
      )}
    </div>
  );
}
