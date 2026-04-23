import type { ReactElement } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/rbac";
import {
  loadDevice,
  loadNeighbors,
  loadCircuits,
  type Circuit,
  type DeviceDetail,
  type NeighborSort,
} from "@/lib/device-detail";
import { iconFor } from "@/lib/icons";
import { LevelBadge, type LevelValue } from "@/components/LevelBadge";
import { NeighborsTable } from "@/app/_components/neighbors-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function dashIfNull(v: string | null | undefined): string {
  return v ?? "—";
}

export function DeviceDetailHeader({
  device,
}: {
  device: DeviceDetail;
}): ReactElement {
  return (
    <header className="space-y-2">
      <div className="flex items-center gap-3">
        <div aria-hidden="true" className="shrink-0">
          {iconFor(device.role)}
        </div>
        <h1
          className="font-mono text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50"
          data-testid="device-page-name"
        >
          {device.name}
        </h1>
        <LevelBadge level={device.level as LevelValue} />
      </div>
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12px] text-slate-500 dark:text-slate-400">
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-wider text-[10px]">role</dt>
          <dd className="text-slate-700 dark:text-slate-200">{device.role}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-wider text-[10px]">site</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-200">
            {dashIfNull(device.site)}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-wider text-[10px]">vendor</dt>
          <dd className="text-slate-700 dark:text-slate-200">
            {dashIfNull(device.vendor)}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-wider text-[10px]">domain</dt>
          <dd className="text-slate-700 dark:text-slate-200">
            {dashIfNull(device.domain)}
          </dd>
        </div>
      </dl>
    </header>
  );
}

export function CircuitsTable({ rows }: { rows: Circuit[] }): ReactElement {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
        No circuits
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
      <table className="min-w-full divide-y divide-slate-200 text-left text-[12px] dark:divide-slate-800">
        <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-950/40 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2">Mobily CID</th>
            <th scope="col" className="px-3 py-2">CID</th>
            <th scope="col" className="px-3 py-2">Role</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
          {rows.map((c) => (
            <tr key={c.cid}>
              <td className="px-3 py-2 font-mono text-slate-700 dark:text-slate-200">
                {c.mobily_cid ?? (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-slate-700 dark:text-slate-200">
                {c.cid}
              </td>
              <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                {c.role}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionLink({
  href,
  label,
  testid,
}: {
  href: string;
  label: string;
  testid: string;
}): ReactElement {
  return (
    <Link
      href={href}
      data-testid={testid}
      className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800 dark:hover:bg-slate-800"
    >
      {label}
    </Link>
  );
}

function parsePage(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function parseSort(raw: string | string[] | undefined): NeighborSort {
  const s = Array.isArray(raw) ? raw[0] : raw;
  return s === "level" ? "level" : "role";
}

export default async function DevicePage({
  params,
  searchParams,
}: {
  params: { name: string };
  searchParams?: { page?: string | string[]; sort?: string | string[] };
}) {
  await requireRole("viewer");
  const name = decodeURIComponent(params.name);

  const device = await loadDevice(name);
  if (!device) notFound();

  const page = parsePage(searchParams?.page);
  const sortBy = parseSort(searchParams?.sort);

  const [neighbors, circuits] = await Promise.all([
    loadNeighbors(name, { page, size: PAGE_SIZE, sortBy }),
    loadCircuits(name),
  ]);

  const encoded = encodeURIComponent(name);

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <DeviceDetailHeader device={device} />

      <nav className="flex flex-wrap items-center gap-2">
        <ActionLink
          href={`/path/${encoded}`}
          label="Trace to core"
          testid="action-trace"
        />
        <ActionLink
          href={`/device/${encoded}/downstream`}
          label="Downstream"
          testid="action-downstream"
        />
        <ActionLink
          href={`/topology?around=${encoded}`}
          label="Topology"
          testid="action-topology"
        />
        <ActionLink
          href={`/impact/${encoded}`}
          label="Impact"
          testid="action-impact"
        />
      </nav>

      <section data-testid="neighbors" className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Neighbors ({neighbors.total})
        </h2>
        <NeighborsTable
          rows={neighbors.rows}
          total={neighbors.total}
          page={page}
          size={PAGE_SIZE}
          sortBy={sortBy}
          deviceName={name}
        />
      </section>

      <section data-testid="circuits" className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Inbound circuits ({circuits.length})
        </h2>
        <CircuitsTable rows={circuits} />
      </section>
    </main>
  );
}
