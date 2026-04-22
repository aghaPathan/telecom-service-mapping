import { requireRole } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// Stub page — path-trace (#9) and downstream (#10) will fill this in.
export default async function DevicePage({
  params,
}: {
  params: { name: string };
}) {
  await requireRole("viewer");
  const name = decodeURIComponent(params.name);
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1
        className="text-2xl font-semibold tracking-tight"
        data-testid="device-page-name"
      >
        {name}
      </h1>
      <p className="mt-2 text-slate-600">
        Device detail page — path trace and downstream views ship in #9 and #10.
      </p>
    </main>
  );
}
