import nextDynamic from "next/dynamic";
import Link from "next/link";
import { requireRole } from "@/lib/rbac";
import { readSitesWithCoords, type SiteWithCoords } from "@/lib/sites";
import { getSiteTopology, type SiteTopoData } from "@/lib/map-topology";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Leaflet touches `window` on import — load the map component only in the
// browser. The SR/keyboard fallback below is always rendered so the page
// is usable without JavaScript.
const MapClient = nextDynamic(
  () => import("./map-client").then((m) => m.MapClient),
  { ssr: false, loading: () => <MapLoading /> },
);

// reactflow also touches `window` at import time — same pattern.
const SiteTopologyPanel = nextDynamic(
  () =>
    import("./_components/site-topology-panel").then(
      (m) => m.SiteTopologyPanel,
    ),
  { ssr: false },
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

type SearchParams = Record<string, string | string[] | undefined>;

function toSingle(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function MapPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  await requireRole("viewer");

  let sites: SiteWithCoords[] = [];
  let error: string | null = null;
  try {
    sites = await readSitesWithCoords();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const site = toSingle(searchParams?.site);
  let topoData: SiteTopoData | null = null;
  if (site) {
    try {
      topoData = await getSiteTopology(site);
    } catch {
      // Gracefully degrade — topology panel will show the empty state.
      topoData = null;
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
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
        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Left column: Leaflet map */}
          <div data-testid="map">
            <MapClient sites={sites} />
          </div>

          {/* Right column: site ego-topology, or empty state */}
          <div data-testid="site-topology">
            {site && topoData ? (
              <SiteTopologyPanel site={site} data={topoData} />
            ) : (
              <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                Select a site on the map to view its topology.
              </div>
            )}
          </div>
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
              <div className="block rounded-md border border-slate-200 p-2 hover:bg-slate-50">
                <span className="font-medium">{s.name}</span>
                {s.region ? (
                  <span className="ml-1 text-xs text-slate-500">
                    {s.region}
                  </span>
                ) : null}
                <span className="ml-1 text-xs text-slate-500">
                  · {s.total} dev
                </span>
                <div className="mt-1 flex gap-2 text-xs">
                  <Link
                    href={`/devices?site=${encodeURIComponent(s.name)}`}
                    className="text-blue-600 underline hover:text-blue-800"
                  >
                    Devices
                  </Link>
                  <a
                    href={`?site=${encodeURIComponent(s.name)}`}
                    className="text-indigo-600 underline hover:text-indigo-800"
                  >
                    Topology
                  </a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
