import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const runDeviceListMock = vi.fn();
vi.mock("@/lib/device-list", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/device-list")>(
      "@/lib/device-list",
    );
  return {
    ...actual,
    runDeviceList: (...a: unknown[]) => runDeviceListMock(...a),
  };
});

import Page from "@/app/core/page";

const SAMPLE_ROWS = [
  { name: "JED-CORE-01", role: "CORE", level: 1, site: "JED", vendor: "Nokia" },
  { name: "JED-CORE-02", role: "CORE", level: 1, site: "JED", vendor: "Nokia" },
  { name: "JED-CORE-03", role: "IRR", level: 1, site: "JED", vendor: "Huawei" },
  { name: "RUH-CORE-01", role: "CORE", level: 1, site: "RUH", vendor: "Nokia" },
  { name: "RUH-CORE-02", role: "VRR", level: 1, site: "RUH", vendor: "Nokia" },
  { name: "DMM-CORE-01", role: "CORE", level: 1, site: "DMM", vendor: "Cisco" },
  { name: "X-CORE-99", role: "CORE", level: 1, site: null, vendor: null },
];

function mockRows() {
  runDeviceListMock.mockResolvedValueOnce({
    rows: SAMPLE_ROWS,
    total: SAMPLE_ROWS.length,
    page: 1,
    pageSize: SAMPLE_ROWS.length,
  });
}

describe("/core page", () => {
  beforeEach(() => {
    runDeviceListMock.mockReset();
  });

  it("calls runDeviceList with mode=byLevel level=1 pageSize=500", async () => {
    mockRows();
    await Page();
    expect(runDeviceListMock).toHaveBeenCalledTimes(1);
    expect(runDeviceListMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byLevel", level: 1, pageSize: 500 }),
    );
  });

  it("renders one section per site group including (no site) bucket", async () => {
    mockRows();
    const el = await Page();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="core-site-JED"`);
    expect(html).toContain(`data-testid="core-site-RUH"`);
    expect(html).toContain(`data-testid="core-site-DMM"`);
    expect(html).toContain(`data-testid="core-site-(no site)"`);
  });

  it("renders a View cluster link for sites with >1 core", async () => {
    mockRows();
    const el = await Page();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="core-cluster-link-JED"`);
    expect(html).toContain(`href="/topology?site=JED"`);
    expect(html).toContain(`data-testid="core-cluster-link-RUH"`);
    expect(html).toContain(`href="/topology?site=RUH"`);
    expect(html).toContain("View cluster");
  });

  it("does NOT render a cluster link for single-core sites or (no site)", async () => {
    mockRows();
    const el = await Page();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).not.toContain(`data-testid="core-cluster-link-DMM"`);
    expect(html).not.toContain(`core-cluster-link-(no site)`);
  });

  it("scopes each section's table rows to only that site's devices", async () => {
    mockRows();
    const el = await Page();
    const html = renderToStaticMarkup(el as React.ReactElement);

    // Split html by sections and check each contains only its site's row names.
    const sections = html.split(/data-testid="core-site-/).slice(1);
    const find = (site: string) =>
      sections.find((s) => s.startsWith(`${site}"`));

    const jed = find("JED")!;
    expect(jed).toContain(`rft-row-JED-CORE-01`);
    expect(jed).toContain(`rft-row-JED-CORE-02`);
    expect(jed).toContain(`rft-row-JED-CORE-03`);
    expect(jed).not.toContain(`rft-row-RUH-CORE-01`);
    expect(jed).not.toContain(`rft-row-DMM-CORE-01`);

    const dmm = find("DMM")!;
    expect(dmm).toContain(`rft-row-DMM-CORE-01`);
    expect(dmm).not.toContain(`rft-row-JED-CORE-01`);
  });

  it("renders amber error panel when resolver throws", async () => {
    runDeviceListMock.mockRejectedValueOnce(new Error("neo4j down"));
    const el = await Page();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="core-error"`);
    expect(html).toContain("Neo4j");
  });
});
