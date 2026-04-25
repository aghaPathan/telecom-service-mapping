import type { IsisFreshness } from "@/lib/isis-status";

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function IsisFreshnessBadge({
  latestObservedAt,
  coverageFraction,
}: IsisFreshness) {
  const now = Date.now();
  const isStale =
    latestObservedAt !== null &&
    now - latestObservedAt.getTime() > STALE_AFTER_MS;

  const tone = isStale
    ? "bg-amber-100 text-amber-900 ring-amber-300"
    : "bg-slate-100 text-slate-800 ring-slate-300";

  const observedLabel =
    latestObservedAt === null ? "—" : latestObservedAt.toISOString();
  const coverageLabel = `${(coverageFraction * 100).toFixed(1)}%`;

  return (
    <div
      data-testid="isis-freshness-badge"
      data-stale={isStale ? "yes" : "no"}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      <span>ISIS weights:</span>
      <span data-testid="isis-coverage">{coverageLabel}</span>
      <span aria-hidden>·</span>
      <span data-testid="isis-observed-at">{observedLabel}</span>
    </div>
  );
}
