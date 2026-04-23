import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathRibbon, type PathRibbonHop } from "@/components/PathRibbon";

const HOPS: PathRibbonHop[] = [
  { hostname: "PK-KHI-CUST-88", role: "Customer", level: 5, site: "PK-KHI-RAN-01" },
  { hostname: "PK-KHI-RAN-33", role: "RAN", level: 4, site: "PK-KHI-RAN-01" },
  { hostname: "PK-KHI-CORE-01", role: "CORE", level: 1, site: "PK-KHI-CORE-01" },
];

describe("PathRibbon", () => {
  it("renders one tile per hop with 01-padded numbered stops", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} />);
    expect(html).toContain('data-testid="path-ribbon"');
    expect(html).toMatch(/data-hop-index="0"/);
    expect(html).toMatch(/data-hop-index="1"/);
    expect(html).toMatch(/data-hop-index="2"/);
    expect(html).toMatch(/>01</);
    expect(html).toMatch(/>02</);
    expect(html).toMatch(/>03</);
  });

  it("renders the empty-state message without role='status' (static content)", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={[]} />);
    expect(html).toContain("No hops to display");
    // role="status" creates a live region; static empty state should not announce.
    expect(html).not.toMatch(/role="status"/);
  });

  it("marks the highlighted hop with aria-current and source label", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} highlightIndex={0} />);
    expect(html).toMatch(/aria-current="location"/);
    expect(html).toContain(">source<");
  });

  it("does not render aria-current when highlightIndex is omitted", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} />);
    expect(html).not.toMatch(/aria-current="location"/);
  });

  it("links each hop hostname to /device/[name] by default", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} />);
    expect(html).toContain('href="/device/PK-KHI-CUST-88"');
    expect(html).toContain('href="/device/PK-KHI-CORE-01"');
  });

  it("respects linkHops={false} for non-navigable uses", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} linkHops={false} />);
    expect(html).not.toContain("/device/PK-KHI-CUST-88");
    // Hostname still rendered as plain text.
    expect(html).toContain("PK-KHI-CUST-88");
  });

  it("focus ring on hop links has both light and dark variants", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} />);
    expect(html).toMatch(/focus-visible:ring-indigo-500/);
    expect(html).toMatch(/dark:focus-visible:ring-indigo-400/);
  });

  it("emits a LevelBadge with matching data-level per hop", () => {
    const html = renderToStaticMarkup(<PathRibbon hops={HOPS} />);
    expect(html).toContain('data-level="5"');
    expect(html).toContain('data-level="4"');
    expect(html).toContain('data-level="1"');
  });

  it("uses a custom aria-label when provided", () => {
    const html = renderToStaticMarkup(
      <PathRibbon hops={HOPS} ariaLabel="Impact blast radius" />,
    );
    expect(html).toMatch(/aria-label="Impact blast radius"/);
  });
});
