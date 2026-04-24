import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

// Mock getHomeKpis
vi.mock("@/lib/kpis", () => ({
  getHomeKpis: vi.fn().mockResolvedValue({
    totalDevices: 42,
    byVendor: { huawei: 30, nokia: 12 },
    isolationCount: 5,
  }),
}));

// Mock Omnibox (it imports server modules)
vi.mock("@/app/_components/omnibox", () => ({
  Omnibox: () => null,
}));

// Mock FreshnessBadge if present in the page
vi.mock("@/app/_components/freshness-badge", () => ({
  FreshnessBadge: () => null,
}));

// Mock rbac
vi.mock("@/lib/rbac", () => ({
  requireRole: async () => undefined,
}));

import HomePage from "@/app/page";

describe("HomePage KPI strip", () => {
  it("renders the kpi section with testid", async () => {
    const el = await HomePage();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain('data-testid="home-kpis"');
  });

  it("shows total device count", async () => {
    const el = await HomePage();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("42");
  });

  it("shows top vendor row (huawei: 30)", async () => {
    const el = await HomePage();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain("huawei");
    expect(html).toContain("30");
  });

  it("shows isolation count linked to /isolations", async () => {
    const el = await HomePage();
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain('href="/isolations"');
    expect(html).toContain("5");
  });
});
