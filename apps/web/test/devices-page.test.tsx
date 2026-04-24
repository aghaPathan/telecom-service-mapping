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

import Page from "@/app/devices/page";

const SAMPLE_ROWS = [
  { name: "JED-AGG-01", role: "AGG", level: 2, site: "JED", vendor: "Nokia" },
  { name: "JED-AGG-02", role: "AGG", level: 2, site: "JED", vendor: "Huawei" },
];

describe("/devices page", () => {
  beforeEach(() => {
    runDeviceListMock.mockReset();
  });

  describe("Case A: no site param", () => {
    it("renders heading and map link without calling runDeviceList", async () => {
      const el = await Page({ searchParams: {} });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toContain("Pick a site");
      expect(html).toContain(`href="/map"`);
      expect(runDeviceListMock).not.toHaveBeenCalled();
    });

    it("does NOT render a device table in the empty state", async () => {
      const el = await Page({ searchParams: {} });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).not.toContain(`data-testid="rft-table"`);
    });
  });

  describe("Case B: site param present", () => {
    it("renders the site name in the heading", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: SAMPLE_ROWS,
        total: 2,
        page: 1,
        pageSize: 25,
      });
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toMatch(/Devices at JED/);
    });

    it("renders each mocked device name as a row", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: SAMPLE_ROWS,
        total: 2,
        page: 1,
        pageSize: 25,
      });
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toContain("JED-AGG-01");
      expect(html).toContain("JED-AGG-02");
    });

    it("renders the CSV download link with encoded site", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: SAMPLE_ROWS,
        total: 2,
        page: 1,
        pageSize: 25,
      });
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toContain(
        `href="/api/devices/list/csv?mode=bySite&amp;site=JED"`,
      );
    });

    it("renders a Back to map link", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: SAMPLE_ROWS,
        total: 2,
        page: 1,
        pageSize: 25,
      });
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toContain(`href="/map"`);
    });

    it("calls runDeviceList with mode=bySite and the correct site", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: SAMPLE_ROWS,
        total: 2,
        page: 1,
        pageSize: 25,
      });
      await Page({ searchParams: { site: "JED" } });
      expect(runDeviceListMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "bySite", site: "JED" }),
      );
    });

    it("does NOT render the CSV link when rows is empty", async () => {
      runDeviceListMock.mockResolvedValueOnce({
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
      });
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).not.toContain(`/api/devices/list/csv`);
    });

    it("renders error panel when resolver throws", async () => {
      runDeviceListMock.mockRejectedValueOnce(new Error("neo4j down"));
      const el = await Page({ searchParams: { site: "JED" } });
      const html = renderToStaticMarkup(el as React.ReactElement);
      expect(html).toContain(`data-testid="devices-error"`);
      expect(html).toContain("Neo4j");
    });
  });
});
