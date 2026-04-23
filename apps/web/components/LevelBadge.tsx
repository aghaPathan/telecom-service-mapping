import type { ReactElement } from "react";

export type LevelValue = 1 | 2 | 3 | 3.5 | 4 | 5 | null | undefined;

type LevelMeta = { label: string; cls: string; accent: string };

// Palette tracks config/hierarchy.yaml. Tokens bg-{c}-100/text-{c}-800/ring-{c}-200
// + dark:bg-{c}-950/dark:text-{c}-200/dark:ring-{c}-800 are asserted by
// test/level-badge.test.tsx and must stay verbatim.
const LEVEL_META: Record<string, LevelMeta> = {
  "1": {
    label: "Core",
    cls: "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800",
    accent: "bg-violet-500 dark:bg-violet-400",
  },
  "2": {
    label: "Aggregation",
    cls: "bg-indigo-100 text-indigo-800 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:ring-indigo-800",
    accent: "bg-indigo-500 dark:bg-indigo-400",
  },
  "3": {
    label: "CustomerAggregation",
    cls: "bg-blue-100 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-800",
    accent: "bg-blue-500 dark:bg-blue-400",
  },
  "3.5": {
    label: "Transport",
    cls: "bg-cyan-100 text-cyan-800 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-800",
    accent: "bg-cyan-500 dark:bg-cyan-400",
  },
  "4": {
    label: "Access",
    cls: "bg-teal-100 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800",
    accent: "bg-teal-500 dark:bg-teal-400",
  },
  "5": {
    label: "Customer",
    cls: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800",
    accent: "bg-emerald-500 dark:bg-emerald-400",
  },
};

const UNKNOWN_META: LevelMeta = {
  label: "Unknown",
  cls: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600",
  accent: "bg-slate-400 dark:bg-slate-500",
};

export function metaForLevel(level: LevelValue): LevelMeta {
  if (level === null || level === undefined) return UNKNOWN_META;
  return LEVEL_META[String(level)] ?? UNKNOWN_META;
}

export type LevelBadgeProps = {
  level: LevelValue;
  /** Prefix the numeric level (e.g. "3.5 · Transport"). */
  showNumber?: boolean;
  className?: string;
};

/**
 * Pill-style hierarchy badge. Leading 3px accent bar boosts visual
 * differentiation between the close-neighbour pastel palettes (violet /
 * indigo / blue and cyan / teal / emerald).
 */
export function LevelBadge({
  level,
  showNumber = false,
  className = "",
}: LevelBadgeProps): ReactElement {
  const meta = metaForLevel(level);
  const numberPart = showNumber && level != null ? `${level} · ` : "";
  return (
    <span
      className={`inline-flex items-stretch overflow-hidden rounded text-[11px] font-medium ring-1 ring-inset ${meta.cls} ${className}`.trim()}
      data-level={level ?? "unknown"}
    >
      <span aria-hidden="true" className={`w-[3px] shrink-0 ${meta.accent}`} />
      <span className="px-2 py-[3px] leading-none font-sans">
        {numberPart}
        {meta.label}
      </span>
    </span>
  );
}
