import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { runDeviceList, type DeviceListRow } from "@/lib/device-list";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const NO_SITE = "(no site)";

// Core devices (level=1) are expected to number in the low hundreds — well
// under this cap. If that ever changes we'd need to paginate like the CSV
// route does; for MVP one page is deliberate (YAGNI). See plan §F.
const CORE_PAGE_CAP = 500;

// Omit the Site column in per-section tables — the section header already
// shows the site. The table still renders sort-header links to /core?sort=…
// which this page does not honor; that's a known MVP limitation (future work).
const CORE_COLUMNS = ["name", "role", "level", "vendor"] as const;

export default async function CorePage() {
  await requireRole("viewer");

  let rows: DeviceListRow[] = [];
  let err: string | null = null;
  try {
    const result = await runDeviceList({
      mode: "byLevel",
      level: 1,
      page: 1,
      pageSize: CORE_PAGE_CAP,
      sort: "name",
      dir: "asc",
    });
    rows = result.rows;
  } catch (e) {
    log("error", "core_page_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    err = "Core list unavailable. Neo4j may be offline — try again in a moment.";
  }

  // Group by site. Null/empty site → NO_SITE bucket.
  const bySite = new Map<string, DeviceListRow[]>();
  for (const r of rows) {
    const k = r.site && r.site.length > 0 ? r.site : NO_SITE;
    const arr = bySite.get(k) ?? [];
    arr.push(r);
    bySite.set(k, arr);
  }
  // Sort sites alphabetically, but push NO_SITE to the end (it would otherwise
  // sort before letters because '(' < 'A' in ASCII).
  const siteNames = [...bySite.keys()].sort((a, b) => {
    if (a === NO_SITE) return 1;
    if (b === NO_SITE) return -1;
    return a.localeCompare(b);
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1
        className="text-2xl font-semibold tracking-tight text-slate-900"
        data-testid="core-page-heading"
      >
        Core devices
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        {rows.length.toLocaleString()} total across{" "}
        {siteNames.length.toLocaleString()}{" "}
        {siteNames.length === 1 ? "site" : "sites"}
      </p>
      {err ? (
        <div
          data-testid="core-error"
          className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
        >
          {err}
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {siteNames.map((site) => {
            const siteRows = bySite.get(site)!;
            const showClusterLink = site !== NO_SITE && siteRows.length > 1;
            return (
              <section key={site} data-testid={`core-site-${site}`}>
                <div className="flex items-baseline justify-between">
                  <h2 className="text-lg font-medium text-slate-800">
                    {site}{" "}
                    <span className="text-sm text-slate-500">
                      ({siteRows.length})
                    </span>
                  </h2>
                  {showClusterLink && (
                    <Link
                      href={`/topology?site=${encodeURIComponent(site)}`}
                      data-testid={`core-cluster-link-${site}`}
                      className="text-xs text-sky-700 hover:underline"
                    >
                      View cluster →
                    </Link>
                  )}
                </div>
                <div className="mt-3">
                  <RoleFilteredTable
                    rows={siteRows}
                    total={siteRows.length}
                    page={1}
                    pageSize={siteRows.length || 1}
                    sort="name"
                    dir="asc"
                    baseHref="/core"
                    carryParams={{}}
                    columns={CORE_COLUMNS}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
