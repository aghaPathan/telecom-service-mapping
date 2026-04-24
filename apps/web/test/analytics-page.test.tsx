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

import Page from "@/app/analytics/page";

describe("/analytics page", () => {
  beforeEach(() => {
    runDeviceListMock.mockReset();
  });

  it("calls runDeviceList with mode=byFanout and parsed role/limit", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [
        { name: "R1", role: "RAN", level: 5, site: "S1", vendor: "H", fanout: 7 },
        { name: "R2", role: "RAN", level: 5, site: "S2", vendor: "H", fanout: 5 },
        { name: "R3", role: "RAN", level: 5, site: "S3", vendor: "H", fanout: 3 },
      ],
      total: 3,
      page: 1,
      pageSize: 3,
    });
    await Page({ searchParams: { role: "RAN", limit: "3" } });
    expect(runDeviceListMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byFanout", role: "RAN", limit: 3 }),
    );
  });

  it("renders a Fanout column and per-row fanout numbers", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [
        { name: "R1", role: "RAN", level: 5, site: "S1", vendor: "H", fanout: 7 },
        { name: "R2", role: "RAN", level: 5, site: "S2", vendor: "H", fanout: 5 },
      ],
      total: 2,
      page: 1,
      pageSize: 2,
    });
    const el = await Page({ searchParams: { role: "RAN", limit: "3" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="rft-header-fanout"`);
    expect(html).toContain(">7<");
    expect(html).toContain(">5<");
  });

  it("renders row links to /device/<encoded-name>", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [
        { name: "PK-KHI-01", role: "RAN", level: 5, site: "S1", vendor: "H", fanout: 2 },
      ],
      total: 1,
      page: 1,
      pageSize: 1,
    });
    const el = await Page({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`href="/device/PK-KHI-01"`);
  });

  it("renders error panel (not 404) when role is unknown; resolver NOT called", async () => {
    const el = await Page({ searchParams: { role: "Nonsense" } });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="analytics-error"`);
    expect(runDeviceListMock).not.toHaveBeenCalled();
  });

  it("defaults limit=20 and no role when query is empty", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 0,
    });
    await Page({ searchParams: {} });
    expect(runDeviceListMock).toHaveBeenCalledTimes(1);
    const arg = runDeviceListMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.mode).toBe("byFanout");
    expect(arg.limit).toBe(20);
    expect(arg.role).toBeUndefined();
  });

  it("renders filter form with role text input and limit 1..200", async () => {
    runDeviceListMock.mockResolvedValueOnce({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 0,
    });
    const el = await Page({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    const roleInput = html.match(/<input[^>]*name="role"[^>]*\/>/);
    expect(roleInput).not.toBeNull();
    expect(roleInput![0]).toContain(`type="text"`);
    const limitInput = html.match(/<input[^>]*name="limit"[^>]*\/>/);
    expect(limitInput).not.toBeNull();
    expect(limitInput![0]).toContain(`min="1"`);
    expect(limitInput![0]).toContain(`max="200"`);
  });
});
