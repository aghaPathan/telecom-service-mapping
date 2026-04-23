import { describe, it, expect } from "vitest";
import { filterByLayer, type SiteWithCoords } from "@/lib/sites";

const SITES: SiteWithCoords[] = [
  {
    name: "JED",
    lat: 21.5,
    lng: 39.1,
    region: "West",
    category: null,
    ran_count: 5,
    ip_count: 3,
    total: 8,
  },
  {
    name: "RUH",
    lat: 24.7,
    lng: 46.6,
    region: "Central",
    category: null,
    ran_count: 0,
    ip_count: 10,
    total: 10,
  },
  {
    name: "ABH",
    lat: 18.2,
    lng: 42.5,
    region: "South",
    category: null,
    ran_count: 4,
    ip_count: 0,
    total: 4,
  },
];

describe("filterByLayer", () => {
  it("'all' returns every site", () => {
    expect(filterByLayer(SITES, "all").map((s) => s.name)).toEqual([
      "JED",
      "RUH",
      "ABH",
    ]);
  });

  it("'ran' drops sites with zero access-tier devices", () => {
    expect(filterByLayer(SITES, "ran").map((s) => s.name)).toEqual([
      "JED",
      "ABH",
    ]);
  });

  it("'ip' drops sites with zero IP-transport devices", () => {
    expect(filterByLayer(SITES, "ip").map((s) => s.name)).toEqual([
      "JED",
      "RUH",
    ]);
  });

  it("returns a fresh array so callers can sort without mutating the input", () => {
    const out = filterByLayer(SITES, "all");
    out.reverse();
    expect(SITES[0]!.name).toBe("JED");
  });
});
