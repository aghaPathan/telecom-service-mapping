import { describe, it, expect } from "vitest";
import { parseDeviceListQuery } from "@/lib/device-list";

describe("parseDeviceListQuery", () => {
  it("defaults page=1 pageSize=50 sort=name dir=asc in byRole mode", () => {
    const q = parseDeviceListQuery({ mode: "byRole", role: "GPON" });
    expect(q).toMatchObject({
      mode: "byRole",
      role: "GPON",
      page: 1,
      pageSize: 50,
      sort: "name",
      dir: "asc",
    });
  });

  it("rejects unknown role", () => {
    expect(() =>
      parseDeviceListQuery({ mode: "byRole", role: "Nonsense" }),
    ).toThrow();
  });

  it("byLevel only accepts canonical level numbers", () => {
    expect(() =>
      parseDeviceListQuery({ mode: "byLevel", level: 1 }),
    ).not.toThrow();
    expect(() =>
      parseDeviceListQuery({ mode: "byLevel", level: 7 }),
    ).toThrow();
  });

  it("byFanout clamps limit to 200", () => {
    const q = parseDeviceListQuery({ mode: "byFanout", limit: "9999" });
    expect(q.mode === "byFanout" && q.limit).toBe(200);
  });

  it("pageSize clamped to 500", () => {
    const q = parseDeviceListQuery({
      mode: "byRole",
      role: "GPON",
      pageSize: "10000",
    });
    expect(q.pageSize).toBe(500);
  });

  it("rejects sort=dropDatabase", () => {
    expect(() =>
      parseDeviceListQuery({
        mode: "byRole",
        role: "GPON",
        sort: "dropDatabase",
      }),
    ).toThrow();
  });
});
