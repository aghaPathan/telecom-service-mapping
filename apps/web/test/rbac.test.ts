import { describe, it, expect } from "vitest";
import { hasRole, ROLES, type Role } from "@/lib/rbac";

describe("rbac", () => {
  const matrix: [Role, Role, boolean][] = [
    ["admin", "admin", true], ["admin", "operator", true], ["admin", "viewer", true],
    ["operator", "admin", false], ["operator", "operator", true], ["operator", "viewer", true],
    ["viewer", "admin", false], ["viewer", "operator", false], ["viewer", "viewer", true],
  ];
  it.each(matrix)("hasRole(%s, %s) = %s", (user, required, expected) => {
    expect(hasRole(user, required)).toBe(expected);
  });
  it("ROLES ordered admin/operator/viewer", () => {
    expect(ROLES).toEqual(["admin", "operator", "viewer"]);
  });
});
