import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/dynamic normally returns a lazy client component. For static render we
// stub it out to a simple tag so assertions can spot the canvas mount.
vi.mock("next/dynamic", () => ({
  default: () =>
    function TopologyCanvasStub() {
      return <div data-testid="topology-canvas-stub" />;
    },
}));

vi.mock("@/lib/rbac", () => ({
  requireRole: vi.fn(async () => ({
    user: { id: "u1", email: "v@example.com", role: "viewer" },
  })),
}));

type CoreResult = {
  nodes: Array<{
    name: string;
    role: string;
    level: number;
    site: string | null;
    domain: string | null;
  }>;
  edges: Array<{ a: string; b: string }>;
};

const { topologyMock, pathMock } = vi.hoisted(() => {
  const empty: CoreResult = { nodes: [], edges: [] };
  return {
    topologyMock: {
      parseTopologyQuery: vi.fn<(input: unknown) => unknown>(),
      hopsToGraphDTO: vi.fn(() => ({
        nodes: [] as unknown[],
        edges: [] as unknown[],
      })),
      applyUpeClustering: vi.fn((nodes: unknown[], edges: unknown[]) => ({
        nodes,
        edges,
      })),
      runEgoGraph: vi.fn<(args: unknown) => Promise<unknown>>(),
      runCoreOverview: vi.fn<() => Promise<CoreResult>>(async () => empty),
    },
    pathMock: {
      runPath: vi.fn<(args: unknown) => Promise<unknown>>(),
    },
  };
});

vi.mock("@/lib/topology", () => topologyMock);
vi.mock("@/lib/path", () => pathMock);

vi.mock("@/lib/logger", () => ({ log: vi.fn() }));

import TopologyPage from "@/app/topology/page";

async function renderPage(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  // App Router server components return a Promise<ReactElement>. Await, then
  // renderToStaticMarkup the resolved tree.
  const element = await (TopologyPage as unknown as (
    props: { searchParams: typeof searchParams },
  ) => Promise<JSX.Element>)({ searchParams });
  return renderToStaticMarkup(element);
}

describe("TopologyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    topologyMock.hopsToGraphDTO.mockReturnValue({ nodes: [], edges: [] });
    topologyMock.applyUpeClustering.mockImplementation((n, e) => ({
      nodes: n,
      edges: e,
    }));
    topologyMock.runCoreOverview.mockResolvedValue({ nodes: [], edges: [] });
  });

  it("renders an error banner when parseTopologyQuery throws", async () => {
    topologyMock.parseTopologyQuery.mockImplementation(() => {
      throw new Error("bad query");
    });
    const html = await renderPage({ from: "oops" });
    expect(html).toContain('data-testid="topology-error"');
    expect(html).toContain("bad query");
  });

  it("surfaces a note banner when path mode returns no_path", async () => {
    topologyMock.parseTopologyQuery.mockReturnValue({
      mode: "path",
      from: { kind: "device", value: "A" },
      to: { kind: "device", value: "B" },
      cluster: null,
      include_transport: true,
    });
    pathMock.runPath.mockResolvedValue({
      status: "no_path",
      reason: "island",
      unreached_at: null,
    });
    const html = await renderPage({ from: "device:A", to: "device:B" });
    expect(html).toContain('data-testid="topology-note"');
    expect(html).not.toContain('data-testid="topology-error"');
    // either canvas stub or empty placeholder must be present
    expect(html).toMatch(
      /data-testid="(topology-canvas-stub|topology-empty)"/,
    );
  });

  it("renders the canvas on a successful core overview", async () => {
    topologyMock.parseTopologyQuery.mockReturnValue({
      mode: "core",
      cluster: null,
      include_transport: true,
    });
    topologyMock.runCoreOverview.mockResolvedValue({
      nodes: [
        {
          name: "JED-CORE-01",
          role: "CORE",
          level: 1,
          site: "JED",
          domain: null,
        },
      ],
      edges: [],
    });
    topologyMock.applyUpeClustering.mockImplementation((n, e) => ({
      nodes: n,
      edges: e,
    }));
    const html = await renderPage({});
    expect(html).not.toContain('data-testid="topology-error"');
    expect(html).not.toContain('data-testid="topology-note"');
    expect(html).toContain('data-testid="topology-canvas-stub"');
  });
});
