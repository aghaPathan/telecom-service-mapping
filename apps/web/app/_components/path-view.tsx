import type { PathResponse, Hop } from "@/lib/path";
import { RoleBadge } from "@/app/_components/role-badge";

type Unreached = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  domain: string | null;
};

function reasonLabel(reason: string): string {
  switch (reason) {
    case "island":
      return "No path to core";
    case "service_has_no_endpoint":
      return "Service has no endpoint device";
    case "start_not_found":
      return "Device not found";
    default:
      return reason;
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

function Connector({ out_if, in_if }: { out_if: string | null; in_if: string | null }) {
  return (
    <div
      className="ml-4 flex items-center gap-2 py-1 text-xs text-slate-500"
      data-testid="path-connector"
    >
      <span className="font-mono">{out_if ?? "—"}</span>
      <span aria-hidden="true">→</span>
      <span className="font-mono">{in_if ?? "—"}</span>
    </div>
  );
}

function NoPathPanel({
  reason,
  unreached_at,
}: {
  reason: string;
  unreached_at: Unreached | null;
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
    return (
      <NoPathPanel
        reason={data.reason}
        unreached_at={data.unreached_at as Unreached | null}
      />
    );
  }
  const { hops } = data;
  return (
    <ol className="space-y-0" data-testid="path-view">
      {hops.map((hop, i) => {
        const next = hops[i + 1];
        return (
          <li key={`${hop.name}-${i}`}>
            <HopRow hop={hop} />
            {next && <Connector out_if={hop.out_if} in_if={next.in_if} />}
          </li>
        );
      })}
    </ol>
  );
}
