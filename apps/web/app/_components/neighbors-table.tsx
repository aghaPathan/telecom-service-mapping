import type { ReactElement } from "react";
import Link from "next/link";
import { hrefForDevice } from "@/components/DeviceCard";
import { LevelBadge, type LevelValue } from "@/components/LevelBadge";
import type { Neighbor, NeighborSort } from "@/lib/device-detail";

type Props = {
  rows: Neighbor[];
  total: number;
  page: number;
  size: number;
  sortBy: NeighborSort;
  deviceName: string;
};

function buildHref(deviceName: string, page: number, sort: NeighborSort): string {
  const qs = new URLSearchParams({ page: String(page), sort });
  return `/device/${encodeURIComponent(deviceName)}?${qs.toString()}`;
}

function StatusCell({ status }: { status: boolean | null }): ReactElement {
  if (status === null) {
    return <span className="text-slate-400">—</span>;
  }
  const label = status ? "up" : "down";
  const cls = status
    ? "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800"
    : "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}
    >
      {label}
    </span>
  );
}

function SortLink({
  label,
  sort,
  current,
  deviceName,
}: {
  label: string;
  sort: NeighborSort;
  current: NeighborSort;
  deviceName: string;
}): ReactElement {
  const isCurrent = current === sort;
  const baseCls =
    "inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset";
  const activeCls =
    "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100";
  const idleCls =
    "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800";
  // Reset to page=0 on sort change.
  return (
    <Link
      href={buildHref(deviceName, 0, sort)}
      data-testid={`sort-${sort}`}
      aria-current={isCurrent ? "true" : undefined}
      className={`${baseCls} ${isCurrent ? activeCls : idleCls}`}
    >
      {label}
    </Link>
  );
}

export function NeighborsTable({
  rows,
  total,
  page,
  size,
  sortBy,
  deviceName,
}: Props): ReactElement {
  const lastPage = Math.max(0, Math.ceil(total / size) - 1);
  const hasPrev = page > 0;
  const hasNext = page < lastPage;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="uppercase tracking-wider text-slate-500">Sort</span>
        <SortLink
          label="Role"
          sort="role"
          current={sortBy}
          deviceName={deviceName}
        />
        <SortLink
          label="Level"
          sort="level"
          current={sortBy}
          deviceName={deviceName}
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
          No neighbors
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
          <table className="min-w-full divide-y divide-slate-200 text-left text-[12px] dark:divide-slate-800">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-950/40 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2">Hostname</th>
                <th scope="col" className="px-3 py-2">Role</th>
                <th scope="col" className="px-3 py-2">Level</th>
                <th scope="col" className="px-3 py-2">Site</th>
                <th scope="col" className="px-3 py-2">Interface</th>
                <th scope="col" className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
              {rows.map((n) => (
                <tr key={n.name}>
                  <td className="px-3 py-2 font-mono text-[12px]">
                    <Link
                      href={hrefForDevice(n.name)}
                      className="text-indigo-700 hover:underline dark:text-indigo-300"
                    >
                      {n.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                    {n.role}
                  </td>
                  <td className="px-3 py-2">
                    <LevelBadge level={n.level as LevelValue} />
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-600 dark:text-slate-300">
                    {n.site ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-600 dark:text-slate-300">
                    <span>{n.local_if ?? "—"}</span>
                    <span className="px-1 text-slate-400">→</span>
                    <span>{n.remote_if ?? "—"}</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusCell status={n.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > size ? (
        <div className="flex items-center justify-between text-[12px] text-slate-600 dark:text-slate-300">
          <span>
            Page {page + 1} of {lastPage + 1} · {total} total
          </span>
          <div className="flex items-center gap-2">
            {hasPrev ? (
              <Link
                href={buildHref(deviceName, page - 1, sortBy)}
                data-testid="neighbors-prev"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                ← Prev
              </Link>
            ) : null}
            {hasNext ? (
              <Link
                href={buildHref(deviceName, page + 1, sortBy)}
                data-testid="neighbors-next"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Next →
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
