import { requireRole } from "@/lib/rbac";
import { runPath, type PathResponse } from "@/lib/path";
import { PathView } from "@/app/_components/path-view";
import { SaveViewButton } from "@/app/_components/save-view-button";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export default async function ServicePage({
  params,
}: {
  params: { cid: string };
}) {
  const session = await requireRole("viewer");
  const cid = decodeURIComponent(params.cid);

  // Same-process direct call — no HTTP round-trip, no auth cookie needed.
  let result: PathResponse | null = null;
  try {
    result = await runPath({ kind: "service", value: cid, to: undefined });
  } catch (err) {
    log("error", "path_page_failed", {
      error: err instanceof Error ? err.message : String(err),
      kind: "service",
      value: cid,
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1
          className="text-2xl font-semibold tracking-tight"
          data-testid="service-page-cid"
        >
          {cid}
        </h1>
        <SaveViewButton
          role={session.user.role}
          payload={{ kind: "path", query: { kind: "service", value: cid } }}
        />
      </div>
      <div className="mt-6">
        {result ? (
          <PathView data={result} />
        ) : (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
            data-testid="path-error"
          >
            Path trace unavailable. Neo4j may be offline — try again in a moment.
          </div>
        )}
      </div>
    </main>
  );
}
