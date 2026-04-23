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
  /** Optional highlighted hop (0-based). Used by impact pages to flag source. */
  highlightIndex?: number;
  /** If true, render hop hostnames as links to /device/[name]. */
  linkHops?: boolean;
  className?: string;
  ariaLabel?: string;
};

/**
 * Horizontal left-to-right ribbon:
 *
 *   [icon]                [icon]                [icon]
 *   hostname   ─────────► hostname   ─────────► hostname
 *   LevelBadge            LevelBadge            LevelBadge
 *
 * Scrolls horizontally if the path is too long for the container. Each hop is
 * a self-contained card so the layout stays legible on narrow screens.
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
        className={`rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400 ${className}`.trim()}
        role="status"
      >
        No hops to display.
      </div>
    );
  }

  return (
    <ol
      className={`flex min-w-0 items-stretch gap-2 overflow-x-auto pb-2 ${className}`.trim()}
      aria-label={ariaLabel}
      data-testid="path-ribbon"
    >
      {hops.map((hop, i) => {
        const highlighted = i === highlightIndex;
        const name = (
          <span
            className="truncate font-mono text-sm font-medium text-slate-900 dark:text-slate-100"
            title={hop.hostname}
          >
            {hop.hostname}
          </span>
        );
        return (
          <li key={`${hop.hostname}-${i}`} className="flex items-center gap-2">
            <div
              className={`flex min-w-[9rem] max-w-[14rem] flex-col items-center gap-1 rounded-lg border p-2 text-center shadow-sm ${
                highlighted
                  ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300 dark:border-indigo-500 dark:bg-indigo-950 dark:ring-indigo-700"
                  : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
              }`}
              data-hop-index={i}
              aria-current={highlighted ? "location" : undefined}
            >
              <div aria-hidden="true">{iconFor(hop.role)}</div>
              {linkHops ? (
                <Link
                  href={`/device/${encodeURIComponent(hop.hostname)}`}
                  className="block min-w-0 max-w-full truncate outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-label={`Open device ${hop.hostname}`}
                >
                  {name}
                </Link>
              ) : (
                name
              )}
              <LevelBadge level={hop.level} />
              {hop.site ? (
                <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={hop.site}>
                  {hop.site}
                </span>
              ) : null}
            </div>
            {i < hops.length - 1 ? (
              <span className="text-slate-400 dark:text-slate-500" aria-hidden="true">
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
