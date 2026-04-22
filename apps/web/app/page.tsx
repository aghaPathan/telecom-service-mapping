import { countDevices } from "@/lib/neo4j";
import { Omnibox } from "./_components/omnibox";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  let count: number | null = null;
  let error: string | null = null;
  try {
    count = await countDevices();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        Telecom Service Mapping
      </h1>
      <p className="mt-2 text-slate-600">
        Search a customer CID, Mobily CID, or device name to trace the path to
        core.
      </p>

      <section className="mt-8">
        <Omnibox />
      </section>

      <section className="mt-10 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        {error ? (
          <p className="text-red-600" data-testid="device-count-error">
            Neo4j unavailable: {error}
          </p>
        ) : (
          <p
            className="text-xl font-medium text-slate-800"
            data-testid="device-count"
          >
            Devices in graph: {count}
          </p>
        )}
      </section>
    </main>
  );
}
