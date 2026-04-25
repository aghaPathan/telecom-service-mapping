import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IsisFreshnessBadge } from "@/app/admin/ingestion/isis-freshness-badge";

describe("<IsisFreshnessBadge />", () => {
  it("fresh: no amber class, shows ISO timestamp + coverage %", () => {
    const fresh = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    const html = renderToStaticMarkup(
      <IsisFreshnessBadge latestObservedAt={fresh} coverageFraction={0.5} />,
    );
    expect(html).not.toContain("bg-amber");
    expect(html).toContain('data-stale="no"');
    expect(html).toContain("50.0%");
    expect(html).toContain(fresh.toISOString());
  });

  it("stale (>30d): amber class + data-stale='yes'", () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const html = renderToStaticMarkup(
      <IsisFreshnessBadge latestObservedAt={old} coverageFraction={0.25} />,
    );
    expect(html).toContain("bg-amber-100");
    expect(html).toContain('data-stale="yes"');
    expect(html).toContain("25.0%");
  });

  it("null observed-at: renders em-dash, not amber", () => {
    const html = renderToStaticMarkup(
      <IsisFreshnessBadge latestObservedAt={null} coverageFraction={0} />,
    );
    expect(html).toContain("—");
    expect(html).not.toContain("bg-amber");
    expect(html).toContain('data-stale="no"');
    expect(html).toContain("0.0%");
  });
});
