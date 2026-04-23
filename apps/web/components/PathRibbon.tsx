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

/**
 * Industrial horizontal ribbon: corner-bracketed hop tiles, numbered stops,
 * and a hairline rail running through the row with orange tick marks at each
 * connection.
 *
 *  01                  02                  03
 *  ┌──────┐    ─╴─╴    ┌──────┐    ─╴─╴    ┌──────┐
 *  │ hop  │            │ hop  │            │ hop  │
 *  └──────┘            └──────┘            └──────┘
 */
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
        className={`relative flex items-center gap-3 border border-dashed border-slate-300 bg-slate-50/50 px-4 py-5 font-mono text-[11px] uppercase tracking-widest text-slate-500 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-400 ${className}`.trim()}
        role="status"
      >
        <span aria-hidden="true" className="h-px w-6 bg-slate-400 dark:bg-slate-600" />
        No hops to display
      </div>
    );
  }

  return (
    <div className={`relative ${className}`.trim()}>
      <ol
        className="relative flex min-w-0 items-stretch gap-0 overflow-x-auto pb-2"
        aria-label={ariaLabel}
        data-testid="path-ribbon"
      >
        {hops.map((hop, i) => {
          const highlighted = i === highlightIndex;
          const name = (
            <span
              className="block truncate font-mono text-[13px] font-medium tracking-tight text-slate-900 dark:text-slate-50"
              title={hop.hostname}
            >
              {hop.hostname}
            </span>
          );
          const isLast = i === hops.length - 1;
          return (
            <li key={`${hop.hostname}-${i}`} className="flex items-stretch">
              <div className="relative flex min-w-[11rem] max-w-[16rem] flex-col">
                {/* Numbered stop indicator. */}
                <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-500">
                  <span className="tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  {highlighted ? (
                    <span className="text-orange-600 dark:text-orange-400">● source</span>
                  ) : null}
                </div>

                {/* Hop tile */}
                <div
                  className={`relative flex flex-1 flex-col items-center gap-1.5 border px-3 py-2.5 text-center transition-colors ${
                    highlighted
                      ? "border-orange-500 bg-orange-50 dark:border-orange-400 dark:bg-orange-500/10"
                      : "border-slate-300 bg-white hover:border-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500"
                  }`}
                  data-hop-index={i}
                  aria-current={highlighted ? "location" : undefined}
                >
                  {/* Corner brackets */}
                  <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-1.5 w-1.5 border-l border-t border-slate-500 dark:border-slate-400" />
                  <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-1.5 w-1.5 border-r border-t border-slate-500 dark:border-slate-400" />
                  <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-1.5 w-1.5 border-b border-l border-slate-500 dark:border-slate-400" />
                  <span aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-1.5 w-1.5 border-b border-r border-slate-500 dark:border-slate-400" />

                  <div aria-hidden="true">{iconFor(hop.role)}</div>
                  {linkHops ? (
                    <Link
                      href={`/device/${encodeURIComponent(hop.hostname)}`}
                      className="block min-w-0 max-w-full outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
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
                      className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-500"
                      title={hop.site}
                    >
                      {hop.site}
                    </span>
                  ) : null}
                </div>
              </div>
              {!isLast ? (
                <div className="mt-[1.35rem] flex shrink-0 items-center px-1.5" aria-hidden="true">
                  <span className="h-px w-3 bg-slate-400 dark:bg-slate-600" />
                  <span className="h-1.5 w-1.5 rotate-45 border border-slate-400 dark:border-slate-600" />
                  <span className="h-px w-3 bg-slate-400 dark:bg-slate-600" />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
