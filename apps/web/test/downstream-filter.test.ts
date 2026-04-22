import { describe, it, expect } from "vitest";
import { filterDevices } from "@/lib/downstream-filter";
import type { DeviceRef } from "@/lib/path";

const sample: DeviceRef[] = [
  { name: "a1", role: "CSG", level: 3, site: "S1", domain: "north" },
  { name: "a2", role: "RAN", level: 4, site: "S2", domain: "North" },
  { name: "a3", role: "Customer", level: 5, site: null, domain: "south" },
  { name: "a4", role: "csg", level: 3, site: null, domain: null },
];

describe("filterDevices", () => {
  it("returns all when no filter supplied", () => {
    expect(filterDevices(sample, {})).toHaveLength(4);
    expect(filterDevices(sample, { role: "", domain: "" })).toHaveLength(4);
  });

  it("role-only filter matches case-insensitively by substring", () => {
    const out = filterDevices(sample, { role: "csg" });
    expect(out.map((d) => d.name)).toEqual(["a1", "a4"]);
  });

  it("domain-only filter matches case-insensitively by substring", () => {
    const out = filterDevices(sample, { domain: "NORTH" });
    expect(out.map((d) => d.name)).toEqual(["a1", "a2"]);
  });

  it("combined role + domain requires both to match (AND)", () => {
    const out = filterDevices(sample, { role: "ran", domain: "north" });
    expect(out.map((d) => d.name)).toEqual(["a2"]);
  });

  it("excludes devices with null domain when domain filter is non-empty", () => {
    const out = filterDevices(sample, { domain: "south" });
    expect(out.map((d) => d.name)).toEqual(["a3"]);
    expect(out.some((d) => d.domain == null)).toBe(false);
  });
});
