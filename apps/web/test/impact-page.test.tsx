import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const runImpactMock = vi.fn();
vi.mock("@/lib/impact", async () => {
  const actual = await vi.importActual<typeof import("@/lib/impact")>(
    "@/lib/impact",
  );
  return { ...actual, runImpact: (...a: unknown[]) => runImpactMock(...a) };
});

import Page from "@/app/impact/[deviceId]/page";

describe("/impact/[deviceId] page", () => {
  beforeEach(() => runImpactMock.mockReset());

  it("renders rows with links back to /device/[name]", async () => {
    runImpactMock.mockResolvedValueOnce({
      status: "ok",
      start: { name: "U", role: "UPE", level: 2 },
      total: 1,
      summary: [{ role: "CSG", level: 3, count: 1 }],
      rows: [
        { name: "C1", role: "CSG", level: 3, site: "S", vendor: "Nokia", hops: 1 },
      ],
    });
    const el = await Page({ params: { deviceId: "U" }, searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`href="/device/C1"`);
    expect(html).toContain("CSG");
    expect(html).toContain("Nokia");
    expect(html).toContain(">1<"); // hops cell
  });

  it("shows not-found panel when resolver returns start_not_found", async () => {
    runImpactMock.mockResolvedValueOnce({ status: "start_not_found" });
    const el = await Page({ params: { deviceId: "nope" }, searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("Device not found");
    expect(html.toLowerCase()).toContain("nope");
  });

  it("shows summary + CSV-only fallback when too_large", async () => {
    runImpactMock.mockResolvedValueOnce({
      status: "too_large",
      start: { name: "U", role: "UPE", level: 2 },
      total: 12345,
      summary: [{ role: "Customer", level: 5, count: 12000 }],
    });
    const el = await Page({ params: { deviceId: "U" }, searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("12,345");
    expect(html).toContain("Download CSV");
    expect(html).not.toContain("<table"); // no in-page table at this scale
  });

  it("round-trips include_transport=true via query string", async () => {
    runImpactMock.mockResolvedValueOnce({
      status: "ok",
      start: { name: "U", role: "UPE", level: 2 },
      total: 0,
      summary: [],
      rows: [],
    });
    await Page({
      params: { deviceId: "U" },
      searchParams: { include_transport: "true" },
    });
    expect(runImpactMock).toHaveBeenCalledWith(
      expect.objectContaining({ include_transport: true }),
    );
  });
});
