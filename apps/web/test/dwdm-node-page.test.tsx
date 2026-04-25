import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const getNodeDwdmMock = vi.fn();
vi.mock("@/lib/dwdm", () => ({
  getNodeDwdm: (...a: unknown[]) => getNodeDwdmMock(...a),
}));

import Page from "@/app/dwdm/[node]/page";

const SAMPLE_NODE = {
  name: "XX-YYY-CORE-01",
  role: "CORE",
  level: 1,
  site: "XX-YYY",
  domain: "DOM-A",
};
const SAMPLE_NEIGHBOUR = {
  name: "XX-YYY-CORE-02",
  role: "CORE",
  level: 1,
  site: "XX-YYY",
  domain: "DOM-A",
};
const SAMPLE_EDGE = {
  a: "XX-YYY-CORE-01",
  b: "XX-YYY-CORE-02",
  ring: "RING-A",
  span_name: "SPAN-A",
  snfn_cids: ["SNFN-1"],
  mobily_cids: ["MOB-1"],
  src_interface: "xe-0/0/0",
  dst_interface: "xe-0/0/1",
};

describe("/dwdm/[node] page", () => {
  beforeEach(() => {
    getNodeDwdmMock.mockReset();
  });

  it("renders heading with the URL-decoded node name", async () => {
    getNodeDwdmMock.mockResolvedValueOnce({
      nodes: [SAMPLE_NODE, SAMPLE_NEIGHBOUR],
      edges: [SAMPLE_EDGE],
    });
    const el = await Page({
      params: { node: encodeURIComponent("XX-YYY-CORE-01") },
    });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-node-heading"`);
    expect(html).toContain("DWDM topology — XX-YYY-CORE-01");
    // Resolver received the decoded name.
    expect(getNodeDwdmMock).toHaveBeenCalledWith("XX-YYY-CORE-01");
  });

  it("empty result renders empty-state copy and a back link to /dwdm", async () => {
    getNodeDwdmMock.mockResolvedValueOnce({ nodes: [], edges: [] });
    const el = await Page({ params: { node: "XX-YYY-CORE-01" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-node-heading"`);
    expect(html).toContain(`data-testid="dwdm-node-empty"`);
    expect(html).toContain("No DWDM links found for this device.");
    expect(html).toContain(`data-testid="dwdm-node-back"`);
    expect(html).toContain(`href="/dwdm"`);
  });

  it("resolver throw renders ErrorPanel and still includes heading", async () => {
    getNodeDwdmMock.mockRejectedValueOnce(new Error("neo4j down"));
    const el = await Page({ params: { node: "XX-YYY-CORE-01" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-node-error"`);
    expect(html).toContain("Neo4j");
    expect(html).toContain(`data-testid="dwdm-node-heading"`);
    expect(html).not.toContain(`data-testid="dwdm-node-empty"`);
  });

  it("URL-encoded slash-bearing names round-trip via decodeURIComponent", async () => {
    getNodeDwdmMock.mockResolvedValueOnce({ nodes: [], edges: [] });
    const raw = "XX-YYY-CORE-01/A";
    const el = await Page({ params: { node: encodeURIComponent(raw) } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`DWDM topology — ${raw}`);
    expect(getNodeDwdmMock).toHaveBeenCalledWith(raw);
  });
});
