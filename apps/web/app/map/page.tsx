import nextDynamic from "next/dynamic";
import Link from "next/link";
import { readSitesWithCoords, type SiteWithCoords } from "@/lib/sites";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Leaflet touches `window` on import — load the map component only in the
// browser. The SR/keyboard fallback below is always rendered so the page
// is usable without JavaScript.
const MapClient = nextDynamic(
  () => import("./map-client").then((m) => m.MapClient),
  { ssr: false, loading: () => <MapLoading /> },
);

function MapLoading() {
  return (
    <div
      className="flex h-[560px] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500"
      data-testid="map-loading"
    >
      Loading map…
    </div>
  );
}

export default async function MapPage() {
  let sites: SiteWithCoords[] = [];
  let error: string | null = null;
  try {
    sites = await readSitesWithCoords();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Sites — geographic view
        </h1>
        <p className="text-sm text-slate-500">
          {sites.length} sites with coordinates
        </p>
      </header>

      {error ? (
        <p
          className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          data-testid="map-error"
        >
          Neo4j unavailable: {error}
        </p>
      ) : sites.length === 0 ? (
        <p
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          data-testid="map-empty"
        >
          No sites have geographic coordinates yet. Populate{" "}
          <code className="mx-1 rounded bg-white px-1">config/sites.yaml</code>
          and re-run the nightly ingest to fill this map.
        </p>
      ) : (
        <section className="mt-6">
          <MapClient sites={sites} />
        </section>
      )}

      {/* Accessibility fallback — always rendered so keyboard and
          screen-reader users can browse sites without the map canvas. */}
      <section aria-label="Sites list" className="mt-10">
        <h2 className="text-sm font-medium text-slate-700">Site index</h2>
        <ul
          className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
          data-testid="map-site-list"
        >
          {sites.map((s) => (
            <li key={s.name}>
              <Link
                href={`/devices?site=${encodeURIComponent(s.name)}`}
                className="block rounded-md border border-slate-200 p-2 hover:bg-slate-50"
              >
                <span className="font-medium">{s.name}</span>
                {s.region ? (
                  <span className="ml-1 text-xs text-slate-500">
                    {s.region}
                  </span>
                ) : null}
                <span className="ml-1 text-xs text-slate-500">
                  · {s.total} dev
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
