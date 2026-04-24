import { describe, it, expect } from "vitest";
import { isKnownRole, getAllRoles } from "@/lib/role-allowlist";

describe("role allowlist (from config/hierarchy.yaml)", () => {
  it("returns true for every canonical role in the shipped hierarchy", () => {
    const roles = getAllRoles();
    expect(roles).toEqual(
      expect.arrayContaining(["CORE", "UPE", "CSG", "GPON", "SW", "MW", "RAN", "PTP", "PMP", "Customer"]),
    );
  });

  it("is case-sensitive: 'ran' is unknown, 'RAN' is known", () => {
    expect(isKnownRole("RAN")).toBe(true);
    expect(isKnownRole("ran")).toBe(false);
  });

  it("Unknown (the hierarchy's unknown_label) is a valid role for queries", () => {
    expect(isKnownRole("Unknown")).toBe(true);
  });

  it("Nonsense rejects", () => {
    expect(isKnownRole("Nonsense")).toBe(false);
  });
});
