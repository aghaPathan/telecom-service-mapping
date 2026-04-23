import type { ViewPayload } from "@/lib/saved-views";

export function savedViewToHref(payload: ViewPayload): string {
  if (payload.kind === "path") {
    const { kind, value } = payload.query;
    // Device-kind path → /path/<name>. Service-kind → /service/<cid>
    // (service page is already path-trace; no detail counterpart).
    const base = kind === "device" ? "/path" : "/service";
    return `${base}/${encodeURIComponent(value)}`;
  }
  const { device, include_transport, max_depth } = payload.query;
  const qs = new URLSearchParams({
    include_transport: String(include_transport),
    max_depth: String(max_depth),
  });
  return `/device/${encodeURIComponent(device)}/downstream?${qs.toString()}`;
}
