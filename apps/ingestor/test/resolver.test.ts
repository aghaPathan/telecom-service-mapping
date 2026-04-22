import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildResolverConfig,
  loadResolverConfigFromDir,
  resolveRole,
  type HierarchyConfig,
  type RoleCodesConfig,
} from "../src/resolver.ts";

const HIERARCHY: HierarchyConfig = {
  levels: [
    { level: 1, label: "Core", roles: ["CORE", "IRR", "VRR"] },
    { level: 2, label: "Aggregation", roles: ["UPE"] },
    { level: 3, label: "CustomerAggregation", roles: ["CSG", "GPON", "SW"] },
    { level: 3.5, label: "Transport", roles: ["MW"] },
    { level: 4, label: "Access", roles: ["Ran", "PTP", "PMP"] },
    { level: 5, label: "Customer", roles: ["Customer"] },
  ],
  unknown_label: "Unknown",
  unknown_level: 99,
  sw_dynamic_leveling: { enabled: true },
};

const ROLES: RoleCodesConfig = {
  type_map: {
    ICOR: "CORE",
    IUPE: "UPE",
    ICSG: "CSG",
    GOLT: "GPON",
    IIRR: "IRR",
    IVRR: "VRR",
  },
  name_prefix_map: {},
  fallback: "Unknown",
  resolver_priority: ["type_column", "name_prefix", "fallback"],
};

const cfg = buildResolverConfig(HIERARCHY, ROLES);

describe("resolveRole", () => {
  it("resolves a known type code", () => {
    expect(resolveRole({ name: "anything", type_code: "ICOR" }, cfg)).toEqual({
      role: "CORE",
      level: 1,
    });
    expect(resolveRole({ name: "x", type_code: "GOLT" }, cfg)).toEqual({
      role: "GPON",
      level: 3,
    });
  });

  it("falls back to Unknown for an unrecognized type code", () => {
    expect(resolveRole({ name: "dev", type_code: "WLEF" }, cfg)).toEqual({
      role: "Unknown",
      level: 99,
    });
  });

  it("falls back to Unknown for blank type code", () => {
    expect(resolveRole({ name: "dev", type_code: "" }, cfg)).toEqual({
      role: "Unknown",
      level: 99,
    });
    expect(resolveRole({ name: "dev", type_code: null }, cfg)).toEqual({
      role: "Unknown",
      level: 99,
    });
  });

  it("type column wins over name prefix (conflict → type wins)", () => {
    const withPrefix = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      name_prefix_map: { "XX-UPE-": "UPE" },
    });
    // type_code says CORE, name prefix says UPE → type wins.
    expect(
      resolveRole({ name: "XX-UPE-01", type_code: "ICOR" }, withPrefix),
    ).toEqual({ role: "CORE", level: 1 });
  });

  it("falls through to name prefix when type blank", () => {
    const withPrefix = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      name_prefix_map: { "XX-CORE-": "CORE", "XX-CORE-AGG-": "UPE" },
    });
    // Longest-prefix wins: XX-CORE-AGG- beats XX-CORE-.
    expect(
      resolveRole({ name: "XX-CORE-AGG-01", type_code: null }, withPrefix),
    ).toEqual({ role: "UPE", level: 2 });
    expect(
      resolveRole({ name: "XX-CORE-02", type_code: "" }, withPrefix),
    ).toEqual({ role: "CORE", level: 1 });
  });

  it("unknown role referenced by role_codes falls through to Unknown", () => {
    // role_codes maps to a role the hierarchy does not know about.
    const broken = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      type_map: { ...ROLES.type_map, XGHOST: "GhostRole" },
    });
    expect(resolveRole({ name: "x", type_code: "XGHOST" }, broken)).toEqual({
      role: "Unknown",
      level: 99,
    });
  });
});

describe("buildResolverConfig", () => {
  it("rejects a hierarchy that lists the same role in multiple levels", () => {
    const bad: HierarchyConfig = {
      ...HIERARCHY,
      levels: [
        { level: 1, label: "Core", roles: ["CORE"] },
        { level: 2, label: "Agg", roles: ["CORE"] },
      ],
    };
    expect(() => buildResolverConfig(bad, ROLES)).toThrow(/multiple levels/);
  });
});

describe("loadResolverConfigFromDir", () => {
  const mkdir = (): string => mkdtempSync(path.join(tmpdir(), "resolver-"));

  it("loads the real repo config/ directory", () => {
    const repoConfig = path.resolve(__dirname, "../../../config");
    const loaded = loadResolverConfigFromDir(repoConfig);
    expect(loaded.roleToLevel.get("CORE")).toBe(1);
    expect(loaded.roleToLevel.get("MW")).toBe(3.5);
    expect(loaded.roles.type_map["ICOR"]).toBe("CORE");
  });

  it("fails fast on malformed hierarchy.yaml", () => {
    const dir = mkdir();
    writeFileSync(
      path.join(dir, "hierarchy.yaml"),
      "levels: not-an-array\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "role_codes.yaml"),
      "type_map: {}\n",
      "utf8",
    );
    expect(() => loadResolverConfigFromDir(dir)).toThrow(
      /hierarchy\.yaml invalid/,
    );
  });

  it("fails fast on malformed role_codes.yaml", () => {
    const dir = mkdir();
    writeFileSync(
      path.join(dir, "hierarchy.yaml"),
      `levels:\n  - { level: 1, label: Core, roles: [CORE] }\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "role_codes.yaml"),
      "type_map: [this, is, wrong]\n",
      "utf8",
    );
    expect(() => loadResolverConfigFromDir(dir)).toThrow(
      /role_codes\.yaml invalid/,
    );
  });
});
