import { describe, it, expect } from "vitest";
import {
  canSetVisibility,
  visibleVisibilities,
} from "@/lib/saved-views-visibility";

describe("visibleVisibilities (which shares a user sees in listings)", () => {
  it("viewer sees only role:viewer", () => {
    expect(visibleVisibilities("viewer").sort()).toEqual(["role:viewer"]);
  });

  it("operator sees role:operator + role:viewer", () => {
    expect(visibleVisibilities("operator").sort()).toEqual([
      "role:operator",
      "role:viewer",
    ]);
  });

  it("admin sees all three role:* shares", () => {
    expect(visibleVisibilities("admin").sort()).toEqual([
      "role:admin",
      "role:operator",
      "role:viewer",
    ]);
  });

  it("never returns 'private' (owner clause is separate)", () => {
    for (const r of ["viewer", "operator", "admin"] as const) {
      expect(visibleVisibilities(r)).not.toContain("private");
    }
  });
});

describe("canSetVisibility (can a user set this visibility on write?)", () => {
  it("viewer can only set 'private'", () => {
    expect(canSetVisibility("viewer", "private")).toBe(true);
    expect(canSetVisibility("viewer", "role:viewer")).toBe(false);
    expect(canSetVisibility("viewer", "role:operator")).toBe(false);
    expect(canSetVisibility("viewer", "role:admin")).toBe(false);
  });

  it("operator can set private, role:viewer, role:operator — never role:admin", () => {
    expect(canSetVisibility("operator", "private")).toBe(true);
    expect(canSetVisibility("operator", "role:viewer")).toBe(true);
    expect(canSetVisibility("operator", "role:operator")).toBe(true);
    expect(canSetVisibility("operator", "role:admin")).toBe(false);
  });

  it("admin can set any visibility", () => {
    expect(canSetVisibility("admin", "private")).toBe(true);
    expect(canSetVisibility("admin", "role:viewer")).toBe(true);
    expect(canSetVisibility("admin", "role:operator")).toBe(true);
    expect(canSetVisibility("admin", "role:admin")).toBe(true);
  });
});
