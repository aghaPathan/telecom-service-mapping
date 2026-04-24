import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(),
}));

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

import Page from "@/app/summary/[role]/page";

describe("/summary/[role] page", () => {
  beforeEach(() => {
    runDeviceListMock.mockReset();
    notFoundMock.mockClear();
  });

  it("renders heading, total count, device links, and CSV link for a known role", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [
        { name: "G1", role: "GPON", level: 3, site: "S1", vendor: "Nokia" },
        { name: "G2", role: "GPON", level: 3, site: "S2", vendor: "Nokia" },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    const el = await Page({ params: { role: "GPON" }, searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("GPON");
    expect(html).toContain("2 total");
    expect(html).toContain(`href="/device/G1"`);
    // CSV link must carry role + mode in query string
    const csvMatch = html.match(/href="([^"]*\/api\/devices\/list\/csv[^"]*)"/);
    expect(csvMatch).not.toBeNull();
    expect(csvMatch![1]).toContain("role=GPON");
    expect(csvMatch![1]).toContain("mode=byRole");
  });

  it("calls notFound() for an unknown role", async () => {
    await expect(
      Page({ params: { role: "Nonsense" }, searchParams: {} }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
    expect(runDeviceListMock).not.toHaveBeenCalled();
  });

  it("decodes a URL-encoded role param before allowlist check", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    // "GPON" encoded (no-op for alphanumerics) just to confirm decode path.
    await Page({
      params: { role: encodeURIComponent("GPON") },
      searchParams: {},
    });
    expect(runDeviceListMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byRole", role: "GPON" }),
    );
  });

  it("forces mode=byRole even if searchParams attempts to override", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    await Page({
      params: { role: "GPON" },
      searchParams: { mode: "byFanout", role: "SW" },
    });
    expect(runDeviceListMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byRole", role: "GPON" }),
    );
  });
});
