import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteSelector, filterSites } from "@/components/SiteSelector";

const SITES = ["PK-KHI-CORE-01", "PK-KHI-AGG-02", "PK-ISB-CORE-01", "PK-LHE-CORE-01"];

describe("filterSites (filter behavior)", () => {
  it("returns full list when query is empty", () => {
    expect(filterSites(SITES, "")).toEqual(SITES);
    expect(filterSites(SITES, "   ")).toEqual(SITES);
  });

  it("filters case-insensitively by substring", () => {
    expect(filterSites(SITES, "khi")).toEqual(["PK-KHI-CORE-01", "PK-KHI-AGG-02"]);
    expect(filterSites(SITES, "KHI")).toEqual(["PK-KHI-CORE-01", "PK-KHI-AGG-02"]);
    expect(filterSites(SITES, "agg")).toEqual(["PK-KHI-AGG-02"]);
  });

  it("returns full list when query equals current selection (re-open)", () => {
    // User selected PK-KHI-CORE-01; input still shows it; opening the dropdown
    // should show the full list, not just the currently selected row.
    expect(filterSites(SITES, "PK-KHI-CORE-01", "PK-KHI-CORE-01")).toEqual(SITES);
  });

  it("returns [] when nothing matches (drives 'no results' message)", () => {
    expect(filterSites(SITES, "zzzz")).toEqual([]);
  });
});

describe("SiteSelector (static markup)", () => {
  it("renders combobox ARIA wiring", () => {
    const html = renderToStaticMarkup(
      <SiteSelector sites={SITES} value={null} onChange={() => {}} />,
    );
    expect(html).toContain('data-testid="site-selector"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain("aria-expanded=");
    expect(html).toContain("aria-autocomplete=\"list\"");
    expect(html).toContain("aria-controls=");
  });

  it("renders a labelled clear button when a value is present", () => {
    const html = renderToStaticMarkup(
      <SiteSelector sites={SITES} value="PK-KHI-CORE-01" onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Clear site"');
    // Input pre-fills with the selected value on SSR.
    expect(html).toContain('value="PK-KHI-CORE-01"');
  });

  it("does not render clear button when value is null and input empty", () => {
    const html = renderToStaticMarkup(
      <SiteSelector sites={SITES} value={null} onChange={() => {}} />,
    );
    expect(html).not.toContain('aria-label="Clear site"');
  });

  it("renders keyboard-friendly dark-mode focus classes (accessibility)", () => {
    const html = renderToStaticMarkup(
      <SiteSelector sites={SITES} value={null} onChange={() => {}} />,
    );
    // Focus ring present for keyboard users.
    expect(html).toMatch(/focus:ring-2/);
    // Dark-mode styles present so the combobox works in either theme.
    expect(html).toMatch(/dark:/);
  });

  it("uses a visible label when provided, sr-only fallback is opt-in", () => {
    const html = renderToStaticMarkup(
      <SiteSelector sites={SITES} value={null} onChange={() => {}} label="Origin site" />,
    );
    expect(html).toContain("Origin site");
  });
});
