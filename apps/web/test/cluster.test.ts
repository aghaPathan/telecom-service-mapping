import { describe, it, expect } from "vitest";
import {
  CLUSTER_THRESHOLD,
  parseClusterParam,
  shouldCluster,
} from "@/lib/cluster";

describe("parseClusterParam", () => {
  it("returns true for '1'", () => {
    expect(parseClusterParam("1")).toBe(true);
  });
  it("returns false for '0'", () => {
    expect(parseClusterParam("0")).toBe(false);
  });
  it("returns null (auto) for undefined / null / empty / junk", () => {
    expect(parseClusterParam(undefined)).toBeNull();
    expect(parseClusterParam(null)).toBeNull();
    expect(parseClusterParam("")).toBeNull();
    expect(parseClusterParam("yes")).toBeNull();
    expect(parseClusterParam("2")).toBeNull();
  });
});

describe("shouldCluster", () => {
  it("auto (null override): clusters when UPE count exceeds threshold", () => {
    expect(shouldCluster(CLUSTER_THRESHOLD + 1, null)).toBe(true);
    expect(shouldCluster(CLUSTER_THRESHOLD, null)).toBe(false);
    expect(shouldCluster(0, null)).toBe(false);
  });
  it("explicit true always clusters", () => {
    expect(shouldCluster(0, true)).toBe(true);
    expect(shouldCluster(100, true)).toBe(true);
  });
  it("explicit false never clusters", () => {
    expect(shouldCluster(0, false)).toBe(false);
    expect(shouldCluster(100, false)).toBe(false);
  });
});

describe("CLUSTER_THRESHOLD", () => {
  it("is 3 per hierarchy decision (cluster when >3 UPEs per site)", () => {
    expect(CLUSTER_THRESHOLD).toBe(3);
  });
});
