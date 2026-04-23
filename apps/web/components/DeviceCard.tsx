import type { ReactElement } from "react";
import Link from "next/link";
import { iconFor } from "@/lib/icons";
import { LevelBadge, type LevelValue } from "./LevelBadge";

export type DeviceCardProps = {
  hostname: string;
  role: string | null | undefined;
  level: LevelValue;
  site?: string | null;
  vendor?: string | null;
  /** If omitted, links to /device/[hostname]. */
  href?: string;
  /** Optional monotonic index (e.g. paging). Rendered as "01". */
  index?: number;
  className?: string;
};

export function hrefForDevice(hostname: string): string {
  return `/device/${encodeURIComponent(hostname)}`;
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-500">
        {label}
      </dt>
      <dd className={`truncate ${mono ? "font-mono" : ""} text-slate-700 dark:text-slate-200`}>
        {value}
      </dd>
    </div>
  );
}

export function DeviceCard({
  hostname,
  role,
  level,
  site,
  vendor,
  href,
  index,
  className = "",
}: DeviceCardProps): ReactElement {
  const target = href ?? hrefForDevice(hostname);
  return (
    <Link
      href={target}
      className={`group block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 ${className}`.trim()}
      aria-label={`Open device ${hostname}`}
      data-testid="device-card"
    >
      <div className="flex items-stretch rounded-md border border-slate-200 bg-white transition-colors group-hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:group-hover:border-slate-600">
        <div className="flex shrink-0 items-start justify-center border-r border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/40">
          <div aria-hidden="true" className="mt-0.5">
            {iconFor(role)}
          </div>
        </div>

        <div className="min-w-0 flex-1 px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                {typeof index === "number" ? (
                  <span className="font-mono text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
                    {String(index).padStart(2, "0")}
                  </span>
                ) : null}
                <span
                  className="truncate font-mono text-[13px] font-medium text-slate-900 dark:text-slate-50"
                  title={hostname}
                >
                  {hostname}
                </span>
              </div>
              {role ? (
                <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {role}
                </div>
              ) : null}
            </div>
            <LevelBadge level={level} />
          </div>

          {site || vendor ? (
            <dl className="mt-2 space-y-0.5 text-[11px]">
              {site ? <Field label="site" value={site} mono /> : null}
              {vendor ? <Field label="vendor" value={vendor} /> : null}
            </dl>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
