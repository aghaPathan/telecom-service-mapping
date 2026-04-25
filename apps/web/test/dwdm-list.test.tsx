import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/logger", () => ({ log: () => {} }));

const listDwdmLinksMock = vi.fn();
vi.mock("@/lib/dwdm", () => ({
  listDwdmLinks: (...a: unknown[]) => listDwdmLinksMock(...a),
}));

import Page from "@/app/dwdm/page";

const SAMPLE_ROWS = [
  {
    a_name: "XX-YYY-CORE-01",
    a_role: "CORE",
    a_level: 1,
    b_name: "XX-YYY-CORE-02",
    b_role: "CORE",
    b_level: 1,
    ring: "RING-A",
    span_name: "SPAN-A",
    snfn_cids: ["SNFN-1", "SNFN-2"],
    mobily_cids: ["MOB-1"],
    src_interface: "xe-0/0/0",
    dst_interface: "xe-0/0/1",
  },
  {
    a_name: "XX-YYY-AGG-01",
    a_role: "AGG",
    a_level: 2,
    b_name: "XX-YYY-AGG-02",
    b_role: "AGG",
    b_level: 2,
    ring: "RING-B",
    span_name: null,
    snfn_cids: [],
    mobily_cids: [],
    src_interface: null,
    dst_interface: null,
  },
];

describe("/dwdm page", () => {
  beforeEach(() => {
    listDwdmLinksMock.mockReset();
  });

  it("renders heading and table when rows present", async () => {
    listDwdmLinksMock.mockResolvedValueOnce(SAMPLE_ROWS);
    const el = await Page({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-page-heading"`);
    expect(html).toContain("DWDM Links");
    expect(html).toContain(`data-testid="dwdm-table"`);
    expect(html).toContain("XX-YYY-CORE-01");
    expect(html).toContain("XX-YYY-AGG-02");
    expect(html).toContain("SNFN-1 SNFN-2");
    // two rows
    const rowCount = (html.match(/data-testid="dwdm-row"/g) ?? []).length;
    expect(rowCount).toBe(2);
  });

  it("empty rows render empty-state copy and no table", async () => {
    listDwdmLinksMock.mockResolvedValueOnce([]);
    const el = await Page({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-empty"`);
    expect(html).not.toContain(`data-testid="dwdm-table"`);
    expect(html).not.toContain(`data-testid="dwdm-row"`);
    // no CSV link when empty
    expect(html).not.toContain(`data-testid="dwdm-csv-link"`);
  });

  it("CSV link contains URL-encoded current filter params", async () => {
    listDwdmLinksMock.mockResolvedValueOnce(SAMPLE_ROWS);
    const el = await Page({
      searchParams: {
        device_a: "XX-YYY-CORE-01",
        ring: "RING A",
      },
    });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-csv-link"`);
    // URLSearchParams encodes space as `+` and `-` is left as-is.
    expect(html).toContain("format=csv");
    expect(html).toContain("device_a=XX-YYY-CORE-01");
    expect(html).toContain("ring=RING+A");
  });

  it("renders error panel when resolver throws and no table", async () => {
    listDwdmLinksMock.mockRejectedValueOnce(new Error("neo4j down"));
    const el = await Page({ searchParams: {} });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`data-testid="dwdm-error"`);
    expect(html).toContain("Neo4j");
    expect(html).not.toContain(`data-testid="dwdm-table"`);
    expect(html).not.toContain(`data-testid="dwdm-csv-link"`);
  });

  it("filter form preserves current values via defaultValue", async () => {
    listDwdmLinksMock.mockResolvedValueOnce(SAMPLE_ROWS);
    const el = await Page({
      searchParams: {
        device_a: "XX-YYY-CORE-01",
        device_b: "XX-YYY-CORE-02",
        ring: "RING-A",
        span_name: "SPAN-A",
      },
    });
    const html = renderToStaticMarkup(el as React.ReactElement);
    expect(html).toContain(`name="device_a"`);
    expect(html).toContain(`value="XX-YYY-CORE-01"`);
    expect(html).toContain(`value="XX-YYY-CORE-02"`);
    expect(html).toContain(`value="RING-A"`);
    expect(html).toContain(`value="SPAN-A"`);
  });

  it("forwards trimmed filters to listDwdmLinks", async () => {
    listDwdmLinksMock.mockResolvedValueOnce([]);
    await Page({
      searchParams: { device_a: "  XX-YYY-CORE-01  ", ring: "" },
    });
    expect(listDwdmLinksMock).toHaveBeenCalledWith({
      device_a: "XX-YYY-CORE-01",
      device_b: undefined,
      ring: undefined,
      span_name: undefined,
    });
  });
});
