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
  /** If omitted, renders a link to /device/[hostname]. */
  href?: string;
  /** Monotonic index shown in the card corner (e.g. "01"). */
  index?: number;
  className?: string;
};

export function hrefForDevice(hostname: string): string {
  return `/device/${encodeURIComponent(hostname)}`;
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-slate-500 dark:text-slate-500">
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
      className={`group relative block rounded-none outline-none focus-visible:ring-2 focus-visible:ring-orange-500 dark:focus-visible:ring-orange-400 ${className}`.trim()}
      aria-label={`Open device ${hostname}`}
      data-testid="device-card"
    >
      {/* Corner brackets — framing detail that replaces a soft rounded border. */}
      <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-2 w-2 border-l border-t border-slate-400 dark:border-slate-600 transition-colors group-hover:border-orange-500 dark:group-hover:border-orange-400" />
      <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-2 w-2 border-r border-t border-slate-400 dark:border-slate-600 transition-colors group-hover:border-orange-500 dark:group-hover:border-orange-400" />
      <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-b border-l border-slate-400 dark:border-slate-600 transition-colors group-hover:border-orange-500 dark:group-hover:border-orange-400" />
      <span aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 border-b border-r border-slate-400 dark:border-slate-600 transition-colors group-hover:border-orange-500 dark:group-hover:border-orange-400" />

      <div className="flex items-stretch border border-slate-300/70 bg-white/80 backdrop-blur-[1px] transition-colors hover:border-slate-500 hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:hover:border-slate-500 dark:hover:bg-slate-900">
        {/* Icon column with vertical rule */}
        <div className="flex shrink-0 items-start justify-center border-r border-slate-200 bg-slate-50/60 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/40">
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
                  className="truncate font-mono text-[13px] font-medium tracking-tight text-slate-900 dark:text-slate-50"
                  title={hostname}
                >
                  {hostname}
                </span>
              </div>
              {role ? (
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  {role}
                </div>
              ) : null}
            </div>
            <LevelBadge level={level} />
          </div>

          {(site || vendor) ? (
            <dl className="mt-2 space-y-0.5 text-[11px]">
              {site ? <Field label="site" value={site} mono /> : null}
              {vendor ? <Field label="vendor" value={vendor} /> : null}
            </dl>
          ) : null}

          {/* Hover-reveal accent rule — echoes the level palette via orange accent. */}
          <div aria-hidden="true" className="mt-2 h-px w-0 bg-orange-500/80 transition-all duration-300 group-hover:w-full dark:bg-orange-400/80" />
        </div>
      </div>
    </Link>
  );
}
