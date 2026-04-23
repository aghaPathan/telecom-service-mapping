import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceCard, hrefForDevice } from "@/components/DeviceCard";

describe("hrefForDevice", () => {
  it("encodes hostnames with reserved characters", () => {
    expect(hrefForDevice("PK-KHI-CORE-01")).toBe("/device/PK-KHI-CORE-01");
    expect(hrefForDevice("edge/01")).toBe("/device/edge%2F01");
    expect(hrefForDevice("foo bar")).toBe("/device/foo%20bar");
  });
});

describe("DeviceCard", () => {
  const base = {
    hostname: "PK-KHI-CORE-01",
    role: "CORE",
    level: 1 as const,
    site: "PK-KHI-AGG-01",
    vendor: "Cisco",
  };

  it("links to /device/[name] by default", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} />);
    expect(html).toContain('href="/device/PK-KHI-CORE-01"');
    expect(html).toContain('aria-label="Open device PK-KHI-CORE-01"');
  });

  it("honors an explicit href override", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} href="/custom/path" />);
    expect(html).toContain('href="/custom/path"');
    expect(html).not.toContain("/device/PK-KHI-CORE-01");
  });

  it("renders the role icon, level badge, site and vendor rows", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} />);
    expect(html).toMatch(/<svg /);
    expect(html).toContain('data-level="1"');
    expect(html).toContain("Core");
    expect(html).toContain("PK-KHI-AGG-01");
    expect(html).toContain("Cisco");
    expect(html).toContain(">site<");
    expect(html).toContain(">vendor<");
  });

  it("omits the site/vendor list entirely when neither is provided", () => {
    const html = renderToStaticMarkup(
      <DeviceCard hostname="x" role="CORE" level={1} />,
    );
    expect(html).not.toContain(">site<");
    expect(html).not.toContain(">vendor<");
  });

  it("renders optional 01-padded index prefix", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} index={3} />);
    expect(html).toContain(">03<");
  });

  it("exposes data-testid for E2E selection", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} />);
    expect(html).toContain('data-testid="device-card"');
  });

  it("keeps a visible focus ring on the outer link (keyboard nav)", () => {
    const html = renderToStaticMarkup(<DeviceCard {...base} />);
    expect(html).toMatch(/focus-visible:ring-2/);
  });
});
