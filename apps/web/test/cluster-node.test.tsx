import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ClusterNodeContent,
  type ClusterNodeData,
} from "@/components/graph/ClusterNode";

// Test the pure presentation component — the reactflow wrapper around it
// requires a zustand provider for Handle, which is out of scope for
// renderToStaticMarkup. The wrapper is covered by the int + e2e suites.
function renderClusterNode(data: ClusterNodeData): string {
  return renderToStaticMarkup(<ClusterNodeContent data={data} />);
}

describe("ClusterNode", () => {
  const baseData: ClusterNodeData = {
    site: "JED",
    role: "UPE",
    count: 5,
    devices: [
      { name: "JED-UPE-01", role: "UPE" },
      { name: "JED-UPE-02", role: "UPE" },
      { name: "JED-UPE-03", role: "UPE" },
      { name: "JED-UPE-04", role: "UPE" },
      { name: "JED-UPE-05", role: "UPE" },
    ],
  };

  it("renders a cluster node with the site + count summary", () => {
    const html = renderClusterNode(baseData);
    expect(html).toContain("JED");
    expect(html).toContain("UPE");
    expect(html).toContain("5 devices");
    expect(html).toMatch(/data-testid="graph-cluster-node"/);
  });

  it("collapsed by default: device names are not rendered", () => {
    const html = renderClusterNode(baseData);
    for (const d of baseData.devices!) {
      expect(html, `should hide ${d.name}`).not.toContain(d.name);
    }
  });

  it("defaultExpanded=true reveals every underlying device name", () => {
    const html = renderClusterNode({ ...baseData, defaultExpanded: true });
    for (const d of baseData.devices!) {
      expect(html, `should show ${d.name}`).toContain(d.name);
    }
  });

  it("exposes a toggle control with data-testid for e2e click", () => {
    const html = renderClusterNode(baseData);
    expect(html).toMatch(/data-testid="cluster-toggle"/);
  });

  it("handles missing devices array (renders summary-only)", () => {
    const html = renderClusterNode({
      site: "JED",
      role: "UPE",
      count: 5,
    });
    expect(html).toContain("5 devices");
    expect(html).toMatch(/data-testid="cluster-toggle"/);
  });
});
