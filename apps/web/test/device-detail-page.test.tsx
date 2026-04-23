import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeviceDetailHeader,
  CircuitsTable,
} from "@/app/device/[name]/page";
import type { Circuit, DeviceDetail } from "@/lib/device-detail";

describe("DeviceDetailHeader", () => {
  it("renders hostname, role, level badge, site, vendor, domain", () => {
    const device: DeviceDetail = {
      name: "PK-KHI-UPE-01",
      role: "UPE",
      level: 2,
      site: "PK-KHI-AGG-01",
      vendor: "Huawei",
      domain: "mobily.net",
    };
    const html = renderToStaticMarkup(<DeviceDetailHeader device={device} />);
    expect(html).toContain("PK-KHI-UPE-01");
    expect(html).toContain("UPE");
    // LevelBadge label for level 2
    expect(html).toContain("Aggregation");
    expect(html).toContain('data-level="2"');
    expect(html).toContain("PK-KHI-AGG-01");
    expect(html).toContain("Huawei");
    expect(html).toContain("mobily.net");
  });

  it("renders '—' placeholders when site/vendor/domain are null", () => {
    const device: DeviceDetail = {
      name: "SOLO",
      role: "Unknown",
      level: 0 as unknown as number,
      site: null,
      vendor: null,
      domain: null,
    };
    const html = renderToStaticMarkup(<DeviceDetailHeader device={device} />);
    expect(html).toContain("SOLO");
    // At least one em-dash placeholder
    expect(html).toContain("—");
  });
});

describe("CircuitsTable", () => {
  it("renders an empty-state when rows is empty", () => {
    const html = renderToStaticMarkup(<CircuitsTable rows={[]} />);
    expect(html).toContain("No circuits");
  });

  it("renders mobily_cid and cid for each row", () => {
    const rows: Circuit[] = [
      { cid: "CID-1001", mobily_cid: "MB-4242", role: "primary" },
    ];
    const html = renderToStaticMarkup(<CircuitsTable rows={rows} />);
    expect(html).toContain("CID-1001");
    expect(html).toContain("MB-4242");
    expect(html).toContain("primary");
  });

  it("renders '—' for null mobily_cid", () => {
    const rows: Circuit[] = [
      { cid: "CID-2002", mobily_cid: null, role: "backup" },
    ];
    const html = renderToStaticMarkup(<CircuitsTable rows={rows} />);
    expect(html).toContain("CID-2002");
    expect(html).toContain("—");
  });
});
