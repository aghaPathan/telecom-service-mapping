import { requireRole } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// Stub page — service-level path trace (#9) will fill this in.
export default async function ServicePage({
  params,
}: {
  params: { cid: string };
}) {
  await requireRole("viewer");
  const cid = decodeURIComponent(params.cid);
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1
        className="text-2xl font-semibold tracking-tight"
        data-testid="service-page-cid"
      >
        {cid}
      </h1>
      <p className="mt-2 text-slate-600">
        Service detail page — path trace lands in #9.
      </p>
    </main>
  );
}
