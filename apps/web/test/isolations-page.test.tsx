import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => undefined,
}));

const listIsolationsMock = vi.fn();
vi.mock("@/lib/isolations", () => ({
  parseIsolationsQuery: vi.fn((i: Record<string, unknown>) => ({ limit: 100, ...i })),
  listIsolations: (...a: unknown[]) => listIsolationsMock(...a),
}));

import IsolationsPage from "@/app/isolations/page";

const SAMPLE_ROWS = [
  {
    device_name: "UPE-01",
    data_source: "huawei-ip",
    vendor: "huawei",
    connected_nodes: [],
    neighbor_count: 0,
    load_dt: new Date("2026-04-24"),
  },
  {
    device_name: "CSG-02",
    data_source: "huawei-ip",
    vendor: "huawei",
    connected_nodes: ["A", "B", "C"],
    neighbor_count: 3,
    load_dt: new Date("2026-04-24"),
  },
];

describe("IsolationsPage", () => {
  beforeEach(() => {
    listIsolationsMock.mockReset();
  });

  it("renders heading, filter form, and table rows with neighbor counts", async () => {
    listIsolationsMock.mockResolvedValueOnce(SAMPLE_ROWS);
    const el = await IsolationsPage({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(">Isolations<");
    expect(html).toContain('placeholder="Vendor"');
    expect(html).toContain(">Neighbors<");
    expect(html).toContain(">UPE-01<");
    expect(html).toContain(">CSG-02<");
    expect(html).toContain(">3<"); // neighbor count
    expect(html).toContain('title="A, B, C"'); // tooltip lists nodes
    expect(html).toContain('href="/device/UPE-01"');
  });

  it("renders empty state when no isolations", async () => {
    listIsolationsMock.mockResolvedValueOnce([]);
    const el = await IsolationsPage({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("No isolations recorded.");
  });
});
