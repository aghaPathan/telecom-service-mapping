import type { ReactElement } from "react";
import Link from "next/link";
import { iconFor } from "@/lib/icons";
import { LevelBadge, type LevelValue } from "./LevelBadge";

export type PathRibbonHop = {
  hostname: string;
  role?: string | null;
  level: LevelValue;
  site?: string | null;
};

export type PathRibbonProps = {
  hops: PathRibbonHop[];
  /** 0-based highlighted hop (e.g. impact source). */
  highlightIndex?: number;
  /** If true (default), hostnames link to /device/[name]. */
  linkHops?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function PathRibbon({
  hops,
  highlightIndex,
  linkHops = true,
  className = "",
  ariaLabel = "Network path",
}: PathRibbonProps): ReactElement {
  if (hops.length === 0) {
    return (
      <div
        className={`rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-400 ${className}`.trim()}
        role="status"
      >
        No hops to display.
      </div>
    );
  }

  return (
    <ol
      className={`flex min-w-0 items-stretch gap-0 overflow-x-auto pb-2 ${className}`.trim()}
      aria-label={ariaLabel}
      data-testid="path-ribbon"
    >
      {hops.map((hop, i) => {
        const highlighted = i === highlightIndex;
        const name = (
          <span
            className="block truncate font-mono text-[13px] font-medium text-slate-900 dark:text-slate-50"
            title={hop.hostname}
          >
            {hop.hostname}
          </span>
        );
        const isLast = i === hops.length - 1;
        return (
          <li key={`${hop.hostname}-${i}`} className="flex items-stretch">
            <div className="relative flex min-w-[9rem] max-w-[13rem] flex-col">
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-500">
                <span className="font-mono tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                {highlighted ? (
                  <span className="font-medium text-indigo-600 dark:text-indigo-400">source</span>
                ) : null}
              </div>

              <div
                className={`flex flex-1 flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 text-center transition-colors ${
                  highlighted
                    ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200 dark:border-indigo-500 dark:bg-indigo-950/40 dark:ring-indigo-800"
                    : "border-slate-200 bg-white hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-600"
                }`}
                data-hop-index={i}
                aria-current={highlighted ? "location" : undefined}
              >
                <div aria-hidden="true">{iconFor(hop.role)}</div>
                {linkHops ? (
                  <Link
                    href={`/device/${encodeURIComponent(hop.hostname)}`}
                    className="block min-w-0 max-w-full outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label={`Open device ${hop.hostname}`}
                  >
                    {name}
                  </Link>
                ) : (
                  name
                )}
                <LevelBadge level={hop.level} />
                {hop.site ? (
                  <span
                    className="mt-0.5 truncate font-mono text-[10px] text-slate-500 dark:text-slate-500"
                    title={hop.site}
                  >
                    {hop.site}
                  </span>
                ) : null}
              </div>
            </div>
            {!isLast ? (
              <div
                className="mt-[1.25rem] flex shrink-0 items-center px-1"
                aria-hidden="true"
              >
                <span className="text-slate-400 dark:text-slate-600">→</span>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
