import { describe, it, expect } from "vitest";
import {
  parseHostname,
  DEFAULT_HOSTNAME_CONFIG,
  type HostnameParseConfig,
} from "@tsm/db";

/**
 * Role map mirrors the identity shape we'd get once S12's `name_token.map`
 * is composed with the S12 type_map — the parser is role-agnostic but the
 * acceptance criteria use ICSG → CSG as the exemplar, so the test config
 * carries the same mapping.
 */
const CFG: HostnameParseConfig = {
  ...DEFAULT_HOSTNAME_CONFIG,
  role_map: {
    ICOR: "CORE",
    IUPE: "UPE",
    ICSG: "CSG",
    IASW: "SW",
    GOLT: "GPON",
    IIRR: "IRR",
    IVRR: "VRR",
    MMWN: "MW",
    MMWE: "MW",
    MMWF: "MW",
    MMWM: "MW",
    MMWR: "MW",
    MMWV: "MW",
    R2GN: "RAN",
    R2GF: "RAN",
    R2GT: "RAN",
    R3GN: "RAN",
    R3GF: "RAN",
    R3GT: "RAN",
    R4GN: "RAN",
    R4GF: "RAN",
    R4GT: "RAN",
    R4G2: "RAN",
    R4G3: "RAN",
    R5GN: "RAN",
    R5GF: "RAN",
    R5GT: "RAN",
    RIPR: "RAN",
    RALL: "RAN",
    RGUX: "RAN",
    RGUF: "RAN",
    RGUL: "RAN",
    RGFX: "RAN",
    RGLX: "RAN",
    RLNX: "RAN",
    RTNX: "RAN",
    RULN: "RAN",
    RULX: "RAN",
    RUFX: "RAN",
    PTP: "PTP",
    PMP: "PMP",
  },
  vendor_token_map: {
    HU: "Huawei",
    NO: "Nokia",
    ER: "Ericsson",
    NC: "Nokia",
    ZT: "ZTE",
  },
};

describe("parseHostname", () => {
  it("parses a canonical 3-letter site hostname", () => {
    expect(parseHostname("JED-ICSG-NO01", CFG)).toEqual({
      site: "JED",
      role: "CSG",
      vendor: "Nokia",
      serial: "01",
    });
  });

  it("parses a numeric-prefixed site hostname", () => {
    expect(parseHostname("E3773-ICSG-NO01", CFG)).toEqual({
      site: "E3773",
      role: "CSG",
      vendor: "Nokia",
      serial: "01",
    });
  });

  it("returns site-only for a hostname without separators", () => {
    expect(parseHostname("malformed", CFG)).toEqual({
      site: "malformed",
      role: null,
      vendor: null,
      serial: null,
    });
  });

  it("returns all-null for an empty string", () => {
    expect(parseHostname("", CFG)).toEqual({
      site: null,
      role: null,
      vendor: null,
      serial: null,
    });
  });

  it("role=null when the role token is not in role_map", () => {
    expect(parseHostname("JED-XXXX-NO01", CFG)).toEqual({
      site: "JED",
      role: null,
      vendor: "Nokia",
      serial: "01",
    });
  });

  it("vendor=null when the vendor prefix is not in vendor_token_map", () => {
    expect(parseHostname("JED-ICOR-XX01", CFG)).toEqual({
      site: "JED",
      role: "CORE",
      vendor: null,
      serial: "01",
    });
  });

  it("handles multi-digit serials", () => {
    expect(parseHostname("RUH-ICOR-HU1234", CFG)).toEqual({
      site: "RUH",
      role: "CORE",
      vendor: "Huawei",
      serial: "1234",
    });
  });

  it("vendor-only token with no digits yields vendor + null serial", () => {
    expect(parseHostname("JED-ICOR-NO", CFG)).toEqual({
      site: "JED",
      role: "CORE",
      vendor: "Nokia",
      serial: null,
    });
  });

  it("digit-only vendor token yields null vendor + serial only", () => {
    expect(parseHostname("JED-ICOR-42", CFG)).toEqual({
      site: "JED",
      role: "CORE",
      vendor: null,
      serial: "42",
    });
  });

  it("legacy NC vendor prefix maps to Nokia", () => {
    expect(parseHostname("JED-IUPE-NC07", CFG).vendor).toBe("Nokia");
  });

  it("respects a custom separator", () => {
    const cfg: HostnameParseConfig = { ...CFG, separator: "_" };
    expect(parseHostname("JED_ICSG_NO01", cfg)).toEqual({
      site: "JED",
      role: "CSG",
      vendor: "Nokia",
      serial: "01",
    });
  });

  it("respects custom token indices", () => {
    const cfg: HostnameParseConfig = {
      ...CFG,
      site_token_index: 1,
      role_token_index: 2,
      vendor_token_index: 3,
    };
    expect(parseHostname("prefix-JED-ICSG-NO01", cfg)).toEqual({
      site: "JED",
      role: "CSG",
      vendor: "Nokia",
      serial: "01",
    });
  });

  it("top-40 role tokens: >= 95% hit rate", () => {
    // Empirical top-40 token list from the live dataset (S12 PRD). If any
    // token here is not in CFG.role_map, this test surfaces the miss.
    const top40 = [
      "ICOR", "ECOR", "IIRR", "IVRR", "IUPE", "ICSG", "IASW", "GOLT",
      "MMWN", "MMWE", "MMWF", "MMWM", "MMWR", "MMWV",
      "R2GN", "R2GF", "R2GT", "R3GN", "R3GF", "R3GT",
      "R4GN", "R4GF", "R4GT", "R4G2", "R4G3", "R5GN", "R5GF", "R5GT",
      "RIPR", "RALL", "RGUX", "RGUF", "RGUL", "RGFX", "RGLX",
      "RLNX", "RTNX", "RULN", "RULX", "RUFX",
    ];
    const hits = top40.filter((tok) => {
      const parsed = parseHostname(`JED-${tok}-NO01`, CFG);
      return parsed.role !== null;
    });
    expect(hits.length / top40.length).toBeGreaterThanOrEqual(0.95);
  });

  it("defaults: empty role/vendor maps resolve structural fields only", () => {
    expect(parseHostname("JED-ICSG-NO01")).toEqual({
      site: "JED",
      role: null,
      vendor: null,
      serial: "01",
    });
  });
});
