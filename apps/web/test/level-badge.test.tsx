import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelBadge, metaForLevel, type LevelValue } from "@/components/LevelBadge";

const CASES: Array<{ level: LevelValue; label: string; colorToken: string }> = [
  { level: 1, label: "Core", colorToken: "violet" },
  { level: 2, label: "Aggregation", colorToken: "indigo" },
  { level: 3, label: "CustomerAggregation", colorToken: "blue" },
  { level: 3.5, label: "Transport", colorToken: "cyan" },
  { level: 4, label: "Access", colorToken: "teal" },
  { level: 5, label: "Customer", colorToken: "emerald" },
];

describe("LevelBadge", () => {
  it.each(CASES)("level $level → label $label with $colorToken palette", ({ level, label, colorToken }) => {
    const meta = metaForLevel(level);
    expect(meta.label).toBe(label);
    expect(meta.cls).toContain(`bg-${colorToken}-100`);
    expect(meta.cls).toContain(`text-${colorToken}-800`);
    expect(meta.cls).toContain(`dark:bg-${colorToken}-950`);
    expect(meta.cls).toContain(`dark:text-${colorToken}-200`);

    const html = renderToStaticMarkup(<LevelBadge level={level} />);
    expect(html).toContain(label);
    expect(html).toContain(`data-level="${level}"`);
  });

  it("renders Unknown fallback for null/undefined", () => {
    expect(metaForLevel(null).label).toBe("Unknown");
    expect(metaForLevel(undefined).label).toBe("Unknown");
    const html = renderToStaticMarkup(<LevelBadge level={null} />);
    expect(html).toContain("Unknown");
    expect(html).toContain('data-level="unknown"');
    expect(html).toContain("bg-slate-100");
    expect(html).toContain("dark:bg-slate-800");
  });

  it("renders Unknown fallback for unrecognized numeric level", () => {
    // TS-narrowed LevelValue excludes arbitrary numbers, but runtime data can.
    const html = renderToStaticMarkup(<LevelBadge level={99 as unknown as LevelValue} />);
    expect(html).toContain("Unknown");
  });

  it("showNumber prefixes numeric level", () => {
    const html = renderToStaticMarkup(<LevelBadge level={3.5} showNumber />);
    expect(html).toContain("3.5 · Transport");
  });

  it("every rendered badge includes ring + dark-mode classes (contrast)", () => {
    for (const { level } of CASES) {
      const html = renderToStaticMarkup(<LevelBadge level={level} />);
      expect(html, `level ${level}`).toMatch(/ring-1/);
      expect(html, `level ${level}`).toMatch(/dark:/);
    }
  });
});
