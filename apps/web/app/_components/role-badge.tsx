export function RoleBadge({ role, level }: { role: string; level: number }) {
  // Level-driven color so future role additions inherit sensible styling.
  const cls =
    level <= 1
      ? "bg-indigo-100 text-indigo-800 ring-indigo-200"
      : level <= 2
        ? "bg-sky-100 text-sky-800 ring-sky-200"
        : level <= 3.5
          ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
          : level <= 4
            ? "bg-amber-100 text-amber-800 ring-amber-200"
            : "bg-slate-100 text-slate-700 ring-slate-200";
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {role}
    </span>
  );
}
