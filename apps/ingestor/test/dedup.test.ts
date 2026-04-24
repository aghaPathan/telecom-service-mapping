import { describe, it, expect } from "vitest";
import { dedupLldpRows, type RawLldpRow } from "../src/dedup.js";
import { FIXTURE } from "./fixtures/lldp-50.ts";

// The fixture rows are structurally identical to RawLldpRow.
const rows = FIXTURE as unknown as RawLldpRow[];

describe("dedupLldpRows", () => {
  it("produces deterministic output shape", () => {
    const r = dedupLldpRows(rows);
    expect(r).toHaveProperty("devices");
    expect(r).toHaveProperty("links");
    expect(r).toHaveProperty("dropped");
    expect(r).toHaveProperty("warnings");
  });

  it("merges symmetric (both-direction) pairs into 1 link", () => {
    // Pick one symmetric pair from the fixture: XX-AAA-CORE-01 <-> XX-BBB-UPE-01
    const scoped = rows.filter(
      (r) =>
        (r.device_a_name === "XX-AAA-CORE-01" && r.device_b_name === "XX-BBB-UPE-01") ||
        (r.device_a_name === "XX-BBB-UPE-01" && r.device_b_name === "XX-AAA-CORE-01"),
    );
    expect(scoped).toHaveLength(2);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(1);
    expect(r.devices).toHaveLength(2);
    const [link] = r.links;
    // Canonical direction: lesser → greater by lowercase
    expect(link!.a.toLowerCase() <= link!.b.toLowerCase()).toBe(true);
    // Properties prefer non-null (trunk was only set on one side).
    expect(link!.trunk).toBe("ae1");
  });

  it("keeps one-direction pair as 1 link", () => {
    const scoped = [rows.find((r) => r.device_a_name === "XX-CCC-CSG-01")!];
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(1);
    expect(r.devices).toHaveLength(2);
  });

  it("anomaly (>2 rows per key) keeps latest updated_at; others warn", () => {
    const scoped = rows.filter(
      (r) =>
        r.device_a_name === "XX-EEE-AGG-01" && r.device_b_name === "XX-FFF-AGG-01",
    );
    expect(scoped).toHaveLength(3);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(1);
    expect(r.dropped.anomaly).toBe(2); // 3 rows - 1 kept = 2 dropped
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.discarded_count).toBe(2);
    // Latest row wins: trunk='ae99', ip set
    expect(r.links[0]!.trunk).toBe("ae99");
  });

  it("drops self-loop rows", () => {
    const scoped = rows.filter((r) => r.device_a_name?.startsWith("XX-LLL-LOOP-"));
    expect(scoped).toHaveLength(2);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(0);
    expect(r.devices).toHaveLength(0);
    expect(r.dropped.self_loop).toBe(2);
  });

  it("drops rows with null device_b_name", () => {
    const scoped = rows.filter((r) => r.device_b_name === null);
    expect(scoped).toHaveLength(2);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(0);
    expect(r.devices).toHaveLength(0);
    expect(r.dropped.null_b).toBe(2);
  });

  it("preserves unicode hostnames", () => {
    const scoped = rows.filter(
      (r) => r.device_a_name === "Δ-CORE-01" || r.device_a_name === "日本-UPE-01",
    );
    expect(scoped).toHaveLength(2);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(2);
    const names = r.devices.map((d) => d.name).sort();
    expect(names).toContain("Δ-CORE-01");
    expect(names).toContain("日本-UPE-01");
  });

  it("mixed-case hostnames merge into single device + single link, first-seen casing wins", () => {
    const scoped = rows.filter(
      (r) =>
        r.device_a_name?.toLowerCase() === "xx-hhh-core-01" ||
        r.device_b_name?.toLowerCase() === "xx-hhh-core-01",
    );
    expect(scoped).toHaveLength(2);
    const r = dedupLldpRows(scoped);
    expect(r.links).toHaveLength(1);
    expect(r.devices).toHaveLength(2);
    const names = r.devices.map((d) => d.name).sort();
    // First-seen row had PascalCase → uppercase variants preserved.
    expect(names).toEqual(["XX-HHH-CORE-01", "XX-III-CORE-02"]);
  });

  it("devices are unique by lowercase(name); links unique by canonical key", () => {
    const r = dedupLldpRows(rows);
    const lcNames = r.devices.map((d) => d.name.toLowerCase());
    expect(new Set(lcNames).size).toBe(lcNames.length);

    const keys = r.links.map((l) => {
      const [lo, hi] = l.a.toLowerCase() <= l.b.toLowerCase()
        ? [l.a.toLowerCase(), l.b.toLowerCase()]
        : [l.b.toLowerCase(), l.a.toLowerCase()];
      const [loIf, hiIf] = l.a.toLowerCase() <= l.b.toLowerCase()
        ? [l.a_if, l.b_if]
        : [l.b_if, l.a_if];
      return `${lo}|${loIf ?? ""}‖${hi}|${hiIf ?? ""}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("full fixture aggregate counts match the fixture coverage header", () => {
    const r = dedupLldpRows(rows);
    expect(r.dropped.null_b).toBe(2);
    expect(r.dropped.self_loop).toBe(2);
    expect(r.dropped.anomaly).toBe(6); // 3 groups × 2 dropped each
    expect(r.warnings).toHaveLength(3);
    // 10 symmetric + 10 one-direction + 3 anomaly + 2 unicode + 1 mixed-case + 3 filler = 29 links
    expect(r.links).toHaveLength(29);
  });
});

const makeRow = (
  a: string,
  b: string | null,
  overrides: Partial<RawLldpRow> = {},
): RawLldpRow =>
  ({
    device_a_name: a,
    device_a_interface: "eth0",
    device_a_trunk_name: null,
    device_a_ip: null,
    device_a_mac: null,
    device_b_name: b,
    device_b_interface: "eth0",
    device_b_ip: null,
    device_b_mac: null,
    vendor_a: null,
    vendor_b: null,
    domain_a: null,
    domain_b: null,
    type_a: null,
    type_b: null,
    updated_at: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  }) as unknown as RawLldpRow;

describe("ingest contract: dedup", () => {
  it("rulePORT: null device_b rows dropped and counted", () => {
    const input = [
      makeRow("XX-CORE-01", null),
      makeRow("XX-CORE-02", "XX-AGG-01"),
    ];
    const r = dedupLldpRows(input);
    expect(r.dropped.null_b).toBe(1);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]!.a.toLowerCase()).not.toBe(r.links[0]!.b.toLowerCase());
  });

  it("rulePORT: self-loop rows dropped and counted", () => {
    const input = [makeRow("XX-CORE-01", "xx-core-01")];
    const r = dedupLldpRows(input);
    expect(r.dropped.self_loop).toBe(1);
    expect(r.links).toHaveLength(0);
  });

  it("rulePORT: anomaly (>2 rows same canonical key) keeps latest updated_at", () => {
    const base = { device_a_interface: "eth0", device_b_interface: "eth0" };
    const input = [
      makeRow("XX-CORE-01", "XX-AGG-01", {
        ...base,
        device_a_trunk_name: "ae1",
        updated_at: new Date("2024-01-01T00:00:00Z"),
      }),
      makeRow("XX-CORE-01", "XX-AGG-01", {
        ...base,
        device_a_trunk_name: "ae2",
        updated_at: new Date("2024-01-02T00:00:00Z"),
      }),
      makeRow("XX-CORE-01", "XX-AGG-01", {
        ...base,
        device_a_trunk_name: "ae99",
        updated_at: new Date("2024-01-03T00:00:00Z"),
      }),
    ];
    const r = dedupLldpRows(input);
    expect(r.links).toHaveLength(1);
    expect(r.dropped.anomaly).toBe(2);
    expect(r.links[0]!.trunk).toBe("ae99");
  });

  it("rulePORT: symmetric (both-direction) pair merged to one link", () => {
    const input = [
      makeRow("XX-CORE-01", "XX-AGG-01"),
      makeRow("XX-AGG-01", "XX-CORE-01"),
    ];
    const r = dedupLldpRows(input);
    expect(r.links).toHaveLength(1);
    expect(r.devices).toHaveLength(2);
  });

  it("rulePORT: first-seen casing wins for device name", () => {
    // First row sees "XX-CORE-01" (uppercase); second row sees "xx-core-01" (lowercase).
    // The output device name should preserve the first-seen form.
    const input = [
      makeRow("XX-CORE-01", "XX-AGG-01"),
      makeRow("xx-core-01", "XX-AGG-02"),
    ];
    const r = dedupLldpRows(input);
    const names = r.devices.map((d) => d.name);
    expect(names).toContain("XX-CORE-01");
    expect(names).not.toContain("xx-core-01");
  });

  it("rulePORT: first-non-null field merge (vendor / domain / ip / mac)", () => {
    // Row 1 has vendor_a = null; row 2 (reverse direction) has vendor_b = "huawei".
    // After symmetric merge, the device node for XX-CORE-01 should have vendor "huawei".
    // (vendor lives on DeviceProps, not LinkProps — LinkProps only carries routing fields.)
    const input = [
      makeRow("XX-CORE-01", "XX-AGG-01", { vendor_a: null }),
      makeRow("XX-AGG-01", "XX-CORE-01", { vendor_b: "huawei" }),
    ];
    const r = dedupLldpRows(input);
    expect(r.links).toHaveLength(1);
    const core = r.devices.find((d) => d.name === "XX-CORE-01");
    expect(core?.vendor).toBe("huawei");
  });

  it("rulePORT: single edge per A→B hop (simple DiGraph)", () => {
    // Two canonically-identical rows (same a→b, same interfaces) → exactly one link.
    const input = [
      makeRow("XX-CORE-01", "XX-AGG-01"),
      makeRow("XX-CORE-01", "XX-AGG-01"),
    ];
    const r = dedupLldpRows(input);
    expect(r.links).toHaveLength(1);
  });
});
