import type { ReactElement } from "react";

export type LevelValue = 1 | 2 | 3 | 3.5 | 4 | 5 | null | undefined;

type LevelMeta = { label: string; cls: string };

// Palette tracks config/hierarchy.yaml. Light bg + dark text in light mode;
// dark bg + light text in dark mode. All combinations clear WCAG AA (>= 4.5:1).
const LEVEL_META: Record<string, LevelMeta> = {
  "1": {
    label: "Core",
    cls: "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800",
  },
  "2": {
    label: "Aggregation",
    cls: "bg-indigo-100 text-indigo-800 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:ring-indigo-800",
  },
  "3": {
    label: "CustomerAggregation",
    cls: "bg-blue-100 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-800",
  },
  "3.5": {
    label: "Transport",
    cls: "bg-cyan-100 text-cyan-800 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-800",
  },
  "4": {
    label: "Access",
    cls: "bg-teal-100 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800",
  },
  "5": {
    label: "Customer",
    cls: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800",
  },
};

const UNKNOWN_META: LevelMeta = {
  label: "Unknown",
  cls: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600",
};

export function metaForLevel(level: LevelValue): LevelMeta {
  if (level === null || level === undefined) return UNKNOWN_META;
  return LEVEL_META[String(level)] ?? UNKNOWN_META;
}

export type LevelBadgeProps = {
  level: LevelValue;
  /** Show the numeric level alongside the label (e.g. "3.5 · Transport"). */
  showNumber?: boolean;
  className?: string;
};

export function LevelBadge({ level, showNumber = false, className = "" }: LevelBadgeProps): ReactElement {
  const meta = metaForLevel(level);
  const numberPart = showNumber && level != null ? `${level} · ` : "";
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.cls} ${className}`.trim()}
      data-level={level ?? "unknown"}
    >
      {numberPart}
      {meta.label}
    </span>
  );
}
