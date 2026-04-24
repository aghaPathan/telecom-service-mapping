import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Stub out next/dynamic so dynamic imports render synchronously in SSR tests.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MapOrTopologyStub() {
      return <div data-testid="dynamic-stub" />;
    },
}));

vi.mock("@/lib/rbac", () => ({
  requireRole: vi.fn(async () => ({
    user: { id: "u1", email: "v@example.com", role: "viewer" },
  })),
}));

vi.mock("@/lib/sites", () => ({
  readSitesWithCoords: vi.fn(async () => [
    {
      name: "JED",
      lat: 21.5,
      lng: 39.2,
      region: "W",
      category: null,
      ran_count: 3,
      ip_count: 2,
      total: 5,
    },
  ]),
}));

const { mapTopoMock } = vi.hoisted(() => ({
  mapTopoMock: {
    getSiteTopology: vi.fn<() => Promise<{ nodes: unknown[]; edges: unknown[] } | null>>(
      async () => ({
        nodes: [{ id: "JED-CORE-01", type: "device", data: {}, position: { x: 0, y: 0 } }],
        edges: [],
      }),
    ),
  },
}));

vi.mock("@/lib/map-topology", () => mapTopoMock);

import MapPage from "@/app/map/page";

type RenderProps = {
  searchParams?: Record<string, string | undefined>;
};

async function renderPage({ searchParams = {} }: RenderProps = {}): Promise<string> {
  const element = await (MapPage as unknown as (
    props: { searchParams: Record<string, string | undefined> },
  ) => Promise<JSX.Element>)({ searchParams });
  return renderToStaticMarkup(element);
}

describe("MapPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mapTopoMock.getSiteTopology.mockResolvedValue({
      nodes: [{ id: "JED-CORE-01", type: "device", data: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
  });

  it("renders map and empty-state when no site selected", async () => {
    const html = await renderPage();
    expect(html).toContain('data-testid="map"');
    expect(html).toContain('data-testid="site-topology"');
    expect(html).toContain("Select a site");
    expect(mapTopoMock.getSiteTopology).not.toHaveBeenCalled();
  });

  it("renders map and topology panel wrapper when site=JED", async () => {
    const html = await renderPage({ searchParams: { site: "JED" } });
    expect(html).toContain('data-testid="map"');
    expect(html).toContain('data-testid="site-topology"');
    expect(mapTopoMock.getSiteTopology).toHaveBeenCalledWith("JED");
    // SiteTopologyPanel is dynamic — mocked as stub; panel section heading should show site name
    expect(html).toContain("JED");
  });

  it("shows empty-state when getSiteTopology returns null (unknown site)", async () => {
    mapTopoMock.getSiteTopology.mockResolvedValue(null);
    const html = await renderPage({ searchParams: { site: "UNKNOWN" } });
    expect(html).toContain('data-testid="site-topology"');
    expect(html).toContain("Select a site");
  });

  it("still renders map even if getSiteTopology throws", async () => {
    mapTopoMock.getSiteTopology.mockRejectedValue(new Error("neo4j down"));
    const html = await renderPage({ searchParams: { site: "JED" } });
    expect(html).toContain('data-testid="map"');
    expect(html).toContain('data-testid="site-topology"');
  });
});
