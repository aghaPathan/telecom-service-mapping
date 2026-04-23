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
    { level: 4, label: "Access", roles: ["RAN", "PTP", "PMP"] },
    { level: 5, label: "Customer", roles: ["Customer"] },
  ],
  unknown_label: "Unknown",
  unknown_level: 99,
  sw_dynamic_leveling: { enabled: true },
};

const ROLES: RoleCodesConfig = {
  type_map: {
    CORE: "CORE",
    IRR: "IRR",
    VRR: "VRR",
    UPE: "UPE",
    CSG: "CSG",
    SW: "SW",
    GPON: "GPON",
    MW: "MW",
    PTP: "PTP",
    PMP: "PMP",
    Ran: "RAN",
    "Business Customer": "Customer",
  },
  name_prefix_map: {},
  name_token: {
    index: 1,
    separator: "-",
    map: {
      ICOR: "CORE",
      IUPE: "UPE",
      ICSG: "CSG",
      IASW: "SW",
      GOLT: "GPON",
      IIRR: "IRR",
      IVRR: "VRR",
      MMWN: "MW",
      R4GN: "RAN",
      PTP: "PTP",
      PMP: "PMP",
    },
  },
  fallback: "Unknown",
  resolver_priority: ["type_column", "name_token", "fallback"],
};

const cfg = buildResolverConfig(HIERARCHY, ROLES);

describe("resolveRole", () => {
  it("identity-maps canonical type codes from live source", () => {
    expect(resolveRole({ name: "anything", type_code: "CORE" }, cfg)).toEqual({
      role: "CORE",
      level: 1,
    });
    expect(resolveRole({ name: "x", type_code: "UPE" }, cfg)).toEqual({
      role: "UPE",
      level: 2,
    });
    expect(resolveRole({ name: "x", type_code: "GPON" }, cfg)).toEqual({
      role: "GPON",
      level: 3,
    });
    expect(resolveRole({ name: "x", type_code: "MW" }, cfg)).toEqual({
      role: "MW",
      level: 3.5,
    });
  });

  it("canonicalizes Ran → RAN via type_map", () => {
    expect(resolveRole({ name: "JED-R4GN-01", type_code: "Ran" }, cfg)).toEqual({
      role: "RAN",
      level: 4,
    });
  });

  it("maps Business Customer → Customer at level 5", () => {
    expect(
      resolveRole({ name: "x", type_code: "Business Customer" }, cfg),
    ).toEqual({ role: "Customer", level: 5 });
  });

  it("falls back to Unknown for an unrecognized type code", () => {
    expect(resolveRole({ name: "dev", type_code: "WLEF" }, cfg)).toEqual({
      role: "Unknown",
      level: 99,
    });
  });

  it("name_token resolves when type is empty string", () => {
    // 37.5% of live rows have empty type — fall through to hostname token.
    expect(
      resolveRole({ name: "JED-ICSG-NO01", type_code: "" }, cfg),
    ).toEqual({ role: "CSG", level: 3 });
    expect(
      resolveRole({ name: "E3773-ICOR-HU02", type_code: null }, cfg),
    ).toEqual({ role: "CORE", level: 1 });
    expect(
      resolveRole({ name: "XYZ-MMWN-ZT01", type_code: "" }, cfg),
    ).toEqual({ role: "MW", level: 3.5 });
  });

  it("name_token falls to Unknown when token not in map and records the token", () => {
    expect(
      resolveRole({ name: "JED-WLEF-NO01", type_code: "" }, cfg),
    ).toEqual({ role: "Unknown", level: 99, unresolved_name_token: "WLEF" });
  });

  it("name_token falls to Unknown when hostname has no separator at index", () => {
    expect(
      resolveRole({ name: "malformed", type_code: "" }, cfg),
    ).toEqual({ role: "Unknown", level: 99 });
  });

  it("type column wins over name token (conflict → type wins)", () => {
    // type_code says CORE, name token says UPE → type wins.
    expect(
      resolveRole({ name: "XX-IUPE-01", type_code: "CORE" }, cfg),
    ).toEqual({ role: "CORE", level: 1 });
  });

  it("back-compat: name_prefix still works when listed in priority", () => {
    const withPrefix = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      name_prefix_map: { "XX-CORE-": "CORE", "XX-CORE-AGG-": "UPE" },
      resolver_priority: ["type_column", "name_prefix", "fallback"],
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

describe("buildResolverConfig hostname-parse config", () => {
  it("exposes a HostnameParseConfig derived from name_token + vendor_token_map", () => {
    const withVendors = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      vendor_token_map: { NO: "Nokia", HU: "Huawei" },
    });
    expect(withVendors.hostname).toEqual({
      site_token_index: 0,
      role_token_index: 1,
      vendor_token_index: 2,
      separator: "-",
      role_map: withVendors.roles.name_token?.map ?? {},
      vendor_token_map: { NO: "Nokia", HU: "Huawei" },
    });
  });

  it("defaults to index 1 / separator '-' when name_token is omitted", () => {
    const noNameToken = buildResolverConfig(HIERARCHY, {
      ...ROLES,
      name_token: undefined,
    });
    expect(noNameToken.hostname.role_token_index).toBe(1);
    expect(noNameToken.hostname.vendor_token_index).toBe(2);
    expect(noNameToken.hostname.separator).toBe("-");
    expect(noNameToken.hostname.role_map).toEqual({});
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
    expect(loaded.roleToLevel.get("RAN")).toBe(4);
    // Live-source canonical type codes identity-map.
    expect(loaded.roles.type_map["CORE"]).toBe("CORE");
    expect(loaded.roles.type_map["Ran"]).toBe("RAN");
    expect(loaded.roles.type_map["Business Customer"]).toBe("Customer");
    // S15: vendor_token_map reaches the built hostname-parse config.
    expect(loaded.hostname.vendor_token_map["NO"]).toBe("Nokia");
    expect(loaded.hostname.vendor_token_map["HU"]).toBe("Huawei");
    expect(loaded.hostname.vendor_token_map["ZT"]).toBe("ZTE");
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
