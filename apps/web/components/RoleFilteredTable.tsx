import Link from "next/link";
import { RoleBadge } from "@/app/_components/role-badge";
import type { DeviceListRow } from "@/lib/device-list";

type SortCol = "name" | "role" | "level" | "site" | "vendor" | "fanout";

export type RoleFilteredTableProps = {
  rows: DeviceListRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  /** Base path (no query string); header links + pagination links are built on top. */
  baseHref: string;
  /** Query params to preserve across sort/page clicks (e.g., role, limit). */
  carryParams?: Record<string, string | undefined>;
  /** If set, render a "Download CSV" link with this href. */
  csvHref?: string;
  /** Columns shown (default omits fanout). */
  columns?: ReadonlyArray<SortCol>;
};

const DEFAULT_COLUMNS: ReadonlyArray<SortCol> = [
  "name",
  "role",
  "level",
  "site",
  "vendor",
];

const COLUMN_LABELS: Record<SortCol, string> = {
  name: "Name",
  role: "Role",
  level: "Level",
  site: "Site",
  vendor: "Vendor",
  fanout: "Fanout",
};

function buildHref(
  base: string,
  carry: Record<string, string | undefined> | undefined,
  override: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  if (carry) {
    for (const [k, v] of Object.entries(carry)) {
      if (v !== undefined && v !== "") params.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function RoleFilteredTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  baseHref,
  carryParams,
  csvHref,
  columns = DEFAULT_COLUMNS,
}: RoleFilteredTableProps) {
  const showFanout =
    columns.includes("fanout") &&
    rows.some((r) => typeof r.fanout === "number");
  const effectiveColumns = columns.filter(
    (c) => c !== "fanout" || showFanout,
  );

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const hasPrev = page > 1;
  const hasNext = page * pageSize < total;

  const prevHref = buildHref(baseHref, carryParams, {
    sort,
    dir,
    page: page - 1,
  });
  const nextHref = buildHref(baseHref, carryParams, {
    sort,
    dir,
    page: page + 1,
  });

  return (
    <div>
      {csvHref && (
        <div className="mb-3 flex justify-end">
          <a
            href={csvHref}
            data-testid="rft-csv-link"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Download CSV
          </a>
        </div>
      )}
      <div className="overflow-x-auto">
        <table
          data-testid="rft-table"
          className="min-w-full divide-y divide-slate-200 text-sm"
        >
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              {effectiveColumns.map((col) => {
                const active = sort === col;
                // Inactive columns: always go to asc. Active: toggle current dir.
                const targetDir: "asc" | "desc" = active
                  ? dir === "asc"
                    ? "desc"
                    : "asc"
                  : "asc";
                const href = buildHref(baseHref, carryParams, {
                  sort: col,
                  dir: targetDir,
                  page,
                });
                return (
                  <th key={col} className="py-2 pr-3">
                    <a
                      href={href}
                      data-testid={`rft-header-${col}`}
                      className="inline-flex items-center gap-1 hover:text-slate-700"
                    >
                      {COLUMN_LABELS[col]}
                      {active && (
                        <span aria-hidden className="text-slate-400">
                          {dir === "asc" ? "▲" : "▼"}
                        </span>
                      )}
                    </a>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr
                key={r.name}
                data-testid={`rft-row-${r.name}`}
              >
                {effectiveColumns.map((col) => (
                  <td key={col} className="py-1.5 pr-3 text-slate-700">
                    {renderCell(r, col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        data-testid="rft-pagination"
        className="mt-4 flex items-center justify-between text-xs text-slate-600"
      >
        <div>
          Page {page} of {totalPages} · {total.toLocaleString()} total
        </div>
        <div className="flex items-center gap-2">
          {hasPrev ? (
            <a
              href={prevHref}
              data-testid="rft-prev"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Prev
            </a>
          ) : (
            <span
              data-testid="rft-prev"
              aria-disabled="true"
              className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-3 py-1 font-medium text-slate-400"
            >
              ← Prev
            </span>
          )}
          {hasNext ? (
            <a
              href={nextHref}
              data-testid="rft-next"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
            >
              Next →
            </a>
          ) : (
            <span
              data-testid="rft-next"
              aria-disabled="true"
              className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-3 py-1 font-medium text-slate-400"
            >
              Next →
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function renderCell(row: DeviceListRow, col: SortCol): React.ReactNode {
  switch (col) {
    case "name":
      return (
        <Link
          href={`/device/${encodeURIComponent(row.name)}`}
          className="text-sky-700 hover:underline"
        >
          {row.name}
        </Link>
      );
    case "role":
      return <RoleBadge role={row.role} level={row.level} />;
    case "level":
      return <span className="tabular-nums">{row.level}</span>;
    case "site":
      return row.site ?? "—";
    case "vendor":
      return row.vendor ?? "—";
    case "fanout":
      return (
        <span className="tabular-nums">
          {typeof row.fanout === "number" ? row.fanout : "—"}
        </span>
      );
  }
}
