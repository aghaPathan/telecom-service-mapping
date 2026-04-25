import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const getRingDwdmMock = vi.fn();
vi.mock("@/lib/dwdm", () => ({
  getRingDwdm: (...a: unknown[]) => getRingDwdmMock(...a),
}));

import Page from "@/app/dwdm/ring/[ring]/page";

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

describe("/dwdm/ring/[ring] page", () => {
  beforeEach(() => {
    getRingDwdmMock.mockReset();
  });

  it("renders heading with the URL-decoded ring name", async () => {
    getRingDwdmMock.mockResolvedValueOnce({
      nodes: [SAMPLE_NODE, SAMPLE_NEIGHBOUR],
      edges: [SAMPLE_EDGE],
    });
    const el = await Page({
      params: { ring: encodeURIComponent("RING-A") },
    });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-ring-heading"`);
    expect(html).toContain("DWDM ring — RING-A");
    expect(getRingDwdmMock).toHaveBeenCalledWith("RING-A");
  });

  it("empty result renders empty-state copy and a back link to /dwdm", async () => {
    getRingDwdmMock.mockResolvedValueOnce({ nodes: [], edges: [] });
    const el = await Page({ params: { ring: "RING-A" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-ring-heading"`);
    expect(html).toContain(`data-testid="dwdm-ring-empty"`);
    expect(html).toContain("No DWDM links found for this ring.");
    expect(html).toContain(`data-testid="dwdm-ring-back"`);
    expect(html).toContain(`href="/dwdm"`);
  });

  it("resolver throw renders ErrorPanel and still includes heading", async () => {
    getRingDwdmMock.mockRejectedValueOnce(new Error("neo4j down"));
    const el = await Page({ params: { ring: "RING-A" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-ring-error"`);
    expect(html).toContain("Neo4j");
    expect(html).toContain(`data-testid="dwdm-ring-heading"`);
    expect(html).not.toContain(`data-testid="dwdm-ring-empty"`);
  });

  it("URL-encoded slash-bearing names round-trip via decodeURIComponent", async () => {
    getRingDwdmMock.mockResolvedValueOnce({ nodes: [], edges: [] });
    const raw = "RING-A/segment-1";
    const el = await Page({ params: { ring: encodeURIComponent(raw) } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`DWDM ring — ${raw}`);
    expect(getRingDwdmMock).toHaveBeenCalledWith(raw);
  });
});
