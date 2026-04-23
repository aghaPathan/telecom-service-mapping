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
  /** If omitted, renders a non-link div. */
  href?: string;
  className?: string;
};

export function hrefForDevice(hostname: string): string {
  return `/device/${encodeURIComponent(hostname)}`;
}

export function DeviceCard({
  hostname,
  role,
  level,
  site,
  vendor,
  href,
  className = "",
}: DeviceCardProps): ReactElement {
  const target = href ?? hrefForDevice(hostname);
  const body = (
    <div
      className={`group flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600 dark:hover:bg-slate-800 ${className}`.trim()}
      data-testid="device-card"
    >
      <div className="mt-0.5 shrink-0" aria-hidden="true">
        {iconFor(role)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate font-mono text-sm font-medium text-slate-900 dark:text-slate-100"
            title={hostname}
          >
            {hostname}
          </span>
          <LevelBadge level={level} />
        </div>
        <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400">
          {role ? (
            <div className="flex gap-1">
              <dt className="sr-only">Role</dt>
              <dd>{role}</dd>
            </div>
          ) : null}
          {site ? (
            <div className="flex gap-1">
              <dt className="font-medium">site</dt>
              <dd className="font-mono">{site}</dd>
            </div>
          ) : null}
          {vendor ? (
            <div className="flex gap-1">
              <dt className="font-medium">vendor</dt>
              <dd>{vendor}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );

  return (
    <Link
      href={target}
      className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      aria-label={`Open device ${hostname}`}
    >
      {body}
    </Link>
  );
}
