import { describe, it, expect } from "vitest";
import { parseSitesYaml } from "../src/sites-coords.ts";

describe("parseSitesYaml", () => {
  it("loads a map of site → coord from valid YAML", () => {
    const coords = parseSitesYaml(`
sites:
  JED: { lat: 21.5433, lng: 39.1728, region: West }
  RUH: { lat: 24.7136, lng: 46.6753 }
`);
    expect(coords.size).toBe(2);
    expect(coords.get("JED")).toEqual({
      lat: 21.5433,
      lng: 39.1728,
      region: "West",
    });
    expect(coords.get("RUH")).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it("returns empty map when 'sites' key is absent", () => {
    expect(parseSitesYaml("").size).toBe(0);
    expect(parseSitesYaml("sites: {}").size).toBe(0);
  });

  it("rejects out-of-range latitude", () => {
    expect(() =>
      parseSitesYaml(`
sites:
  BAD: { lat: 91, lng: 0 }
`),
    ).toThrow(/sites.BAD.lat/);
  });

  it("rejects out-of-range longitude", () => {
    expect(() =>
      parseSitesYaml(`
sites:
  BAD: { lat: 0, lng: 181 }
`),
    ).toThrow(/sites.BAD.lng/);
  });

  it("rejects non-numeric coordinates", () => {
    expect(() =>
      parseSitesYaml(`
sites:
  BAD: { lat: "x", lng: 0 }
`),
    ).toThrow(/sites.BAD.lat/);
  });

  it("rejects empty site codes", () => {
    expect(() =>
      parseSitesYaml(`
sites:
  "": { lat: 0, lng: 0 }
`),
    ).toThrow();
  });

  it("rejects empty region string", () => {
    expect(() =>
      parseSitesYaml(`
sites:
  JED: { lat: 21.5, lng: 39.1, region: "" }
`),
    ).toThrow(/sites.JED.region/);
  });
});
