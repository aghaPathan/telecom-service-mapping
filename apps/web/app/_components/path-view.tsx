import type { PathResponse, Hop, DeviceRef, NoPathReason } from "@/lib/path";
import { RoleBadge } from "@/app/_components/role-badge";

function reasonLabel(reason: NoPathReason): string {
  switch (reason) {
    case "island":
      return "No path to core";
    case "service_has_no_endpoint":
      return "Service has no endpoint device";
    case "start_not_found":
      return "Device not found";
  }
}

function HopRow({ hop }: { hop: Hop }) {
  const subline = [hop.site ?? "—", hop.domain ?? "—"].join(" · ");
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 ring-1 ring-slate-100">
      <RoleBadge role={hop.role} level={hop.level} />
      <div className="flex-1">
        <div className="font-medium text-slate-900" data-testid="path-hop-name">
          {hop.name}
        </div>
        <div className="text-xs text-slate-500">{subline}</div>
      </div>
    </div>
  );
}

function UnweightedBanner() {
  return (
    <div
      data-testid="path-unweighted-banner"
      role="note"
      aria-label="Unweighted path"
      className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      This path includes hops without observed ISIS cost.
      Traversal order reflects hop count, not weighted cost.
    </div>
  );
}

function WeightBadge({ value }: { value: number }) {
  return (
    <span
      data-testid="path-weight-badge"
      className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700"
      aria-label={`ISIS cost ${value}`}
    >
      {value}
    </span>
  );
}

function Connector({
  out_if,
  in_if,
  weight,
}: {
  out_if: string | null;
  in_if: string | null;
  weight: number | null;
}) {
  return (
    <div
      className="ml-4 flex items-center gap-2 py-1 text-xs text-slate-500"
      data-testid="path-connector"
    >
      <span className="font-mono">{out_if ?? "—"}</span>
      <span aria-hidden="true">→</span>
      <span className="font-mono">{in_if ?? "—"}</span>
      {weight !== null && <WeightBadge value={weight} />}
    </div>
  );
}

function NoPathPanel({
  reason,
  unreached_at,
}: {
  reason: NoPathReason;
  unreached_at: DeviceRef | null;
}) {
  return (
    <div
      className="rounded-lg border border-red-200 bg-red-50 p-4 ring-1 ring-red-100"
      data-testid="path-no-path"
    >
      <div className="text-sm font-semibold text-red-900">No core reachable</div>
      <div className="mt-1 text-sm text-red-800">{reasonLabel(reason)}</div>
      {unreached_at && (
        <div className="mt-2 text-xs text-red-700">
          Last reached: <span className="font-medium">{unreached_at.name}</span>
          {" · "}role={unreached_at.role}
          {unreached_at.domain ? ` · domain=${unreached_at.domain}` : ""}
        </div>
      )}
    </div>
  );
}

export function PathView({ data }: { data: PathResponse }) {
  if (data.status === "no_path") {
    return <NoPathPanel reason={data.reason} unreached_at={data.unreached_at} />;
  }
  const { hops, weighted, total_weight } = data;
  return (
    <div>
      {!weighted && <UnweightedBanner />}
      {weighted && total_weight !== null && (
        <div className="mb-3 text-sm text-slate-600">
          Total ISIS cost:{" "}
          <span data-testid="path-total-weight" className="font-mono">
            {total_weight}
          </span>
        </div>
      )}
      <ol
        className="space-y-0"
        data-testid="path-view"
        aria-label="Path trace hops"
      >
        {hops.map((hop, i) => {
          const next = hops[i + 1];
          return (
            <li key={`${hop.name}-${i}`}>
              <HopRow hop={hop} />
              {next && (
                <Connector
                  out_if={hop.out_if}
                  in_if={next.in_if}
                  weight={weighted ? next.edge_weight_in : null}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
