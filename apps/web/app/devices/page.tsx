import { requireRole } from "@/lib/rbac";
import {
  parseDeviceListQuery,
  runDeviceList,
  type DeviceListResult,
} from "@/lib/device-list";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const COLUMNS = ["name", "role", "level", "vendor"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="devices-error"
    >
      {message}
    </div>
  );
}

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("viewer");

  const site =
    typeof searchParams.site === "string" ? searchParams.site : undefined;

  // Empty state — invite the user to pick a site via the map.
  if (!site) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="devices-page-heading"
        >
          Devices
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Pick a site to list its devices. Use the{" "}
          <a href="/map" className="text-sky-700 hover:underline">
            map
          </a>{" "}
          to browse sites.
        </p>
      </main>
    );
  }

  const page =
    typeof searchParams.page === "string" ? searchParams.page : undefined;
  const pageSize =
    typeof searchParams.pageSize === "string"
      ? searchParams.pageSize
      : undefined;

  let q;
  try {
    q = parseDeviceListQuery({ mode: "bySite", site, page, pageSize });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid query.";
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="devices-page-heading"
        >
          Devices at {site}
        </h1>
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
    log("error", "devices_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      site,
    });
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="devices-page-heading"
        >
          Devices at {site}
        </h1>
        <div className="mt-6">
          <ErrorPanel message="Device list unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  const csvHref = `/api/devices/list/csv?mode=bySite&site=${encodeURIComponent(site)}`;

  const carryParams: Record<string, string | undefined> = { site };

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-semibold tracking-tight text-slate-900"
            data-testid="devices-page-heading"
          >
            Devices at {site}
          </h1>
          <p className="mt-1 text-sm text-slate-600" data-testid="devices-total">
            {result.total.toLocaleString()}{" "}
            {result.total === 1 ? "device" : "devices"}
          </p>
        </div>
        <a
          href="/map"
          className="mt-1 text-xs text-sky-700 hover:underline"
          data-testid="devices-back-to-map"
        >
          ← Back to map
        </a>
      </div>
      <div className="mt-6">
        <RoleFilteredTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={q.sort}
          dir={q.dir}
          baseHref="/devices"
          carryParams={carryParams}
          csvHref={result.total > 0 ? csvHref : undefined}
          columns={COLUMNS}
        />
      </div>
    </main>
  );
}
