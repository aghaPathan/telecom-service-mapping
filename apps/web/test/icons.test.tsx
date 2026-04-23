import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { iconFor, ROLE_ICONS, UNKNOWN_LABEL } from "@/lib/icons";

// Mirrors config/hierarchy.yaml. Kept in sync by hand; if hierarchy.yaml
// gains a new role, add it here so iconFor coverage stays exhaustive.
const HIERARCHY_ROLES = [
  "CORE",
  "IRR",
  "VRR",
  "UPE",
  "CSG",
  "GPON",
  "SW",
  "MW",
  "RAN",
  "PTP",
  "PMP",
  "Customer",
];

describe("iconFor", () => {
  it("returns an SVG element for every role in hierarchy.yaml", () => {
    for (const role of HIERARCHY_ROLES) {
      const html = renderToStaticMarkup(iconFor(role));
      expect(html, `role ${role}`).toMatch(/^<svg /);
    }
  });

  it("returns the Unknown fallback for unrecognized roles", () => {
    const html = renderToStaticMarkup(iconFor("NOT-A-REAL-ROLE"));
    const unknownHtml = renderToStaticMarkup(iconFor(UNKNOWN_LABEL));
    expect(html).toBe(unknownHtml);
  });

  it("role lookup is case-insensitive (source type_a is often mixed-case)", () => {
    const upper = renderToStaticMarkup(iconFor("RAN"));
    expect(renderToStaticMarkup(iconFor("ran"))).toBe(upper);
    expect(renderToStaticMarkup(iconFor("Ran"))).toBe(upper);
  });

  it("every icon uses a 24x24 viewBox", () => {
    for (const role of [...HIERARCHY_ROLES, UNKNOWN_LABEL]) {
      const html = renderToStaticMarkup(iconFor(role));
      expect(html, `role ${role}`).toMatch(/viewBox="0 0 24 24"/);
    }
  });

  it("no icon references external images (all inline SVG)", () => {
    for (const role of [...HIERARCHY_ROLES, UNKNOWN_LABEL]) {
      const html = renderToStaticMarkup(iconFor(role));
      expect(html, `role ${role}`).not.toMatch(/<image\b/);
      expect(html, `role ${role}`).not.toMatch(/\bhref=/);
    }
  });

  it("every hierarchy role appears in the ROLE_ICONS registry", () => {
    for (const role of HIERARCHY_ROLES) {
      expect(ROLE_ICONS, `role ${role}`).toHaveProperty(role);
    }
    expect(ROLE_ICONS).toHaveProperty(UNKNOWN_LABEL);
  });

  it("icon color classes flip for dark mode (contrast >= 4.5:1)", () => {
    for (const role of [...HIERARCHY_ROLES, UNKNOWN_LABEL]) {
      const html = renderToStaticMarkup(iconFor(role));
      expect(html, `role ${role}`).toMatch(/text-\w+-(600|700|800)/);
      expect(html, `role ${role}`).toMatch(/dark:text-\w+-(200|300|400)/);
    }
  });
});
