import { describe, it, expect } from "vitest";
import { canonicalizeIsisRows } from "../src/isis-cost-dedup.js";
import type { IsisCostRow } from "../src/source/isis-cost.js";

function row(overrides: Partial<IsisCostRow> = {}): IsisCostRow {
  return {
    device_a_name: "XX-AAA",
    device_a_interface: "Eth0/0",
    device_b_name: "XX-BBB",
    device_b_interface: "Eth0/1",
    weight: 10,
    observed_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("canonicalizeIsisRows", () => {
  it("single row passes through unchanged when already canonical", () => {
    const r = row();
    const out = canonicalizeIsisRows([r]);
    expect(out).toHaveLength(1);
    expect(out[0]!.device_a_name).toBe("XX-AAA");
    expect(out[0]!.device_a_interface).toBe("Eth0/0");
    expect(out[0]!.device_b_name).toBe("XX-BBB");
    expect(out[0]!.device_b_interface).toBe("Eth0/1");
    expect(out[0]!.weight).toBe(10);
  });

  it("normalizes a single non-canonical row to canonical orientation (smaller side as A)", () => {
    const r = row({
      device_a_name: "XX-BBB",
      device_a_interface: "Eth0/1",
      device_b_name: "XX-AAA",
      device_b_interface: "Eth0/0",
      weight: 7,
    });
    const out = canonicalizeIsisRows([r]);
    expect(out).toHaveLength(1);
    expect(out[0]!.device_a_name).toBe("XX-AAA");
    expect(out[0]!.device_a_interface).toBe("Eth0/0");
    expect(out[0]!.device_b_name).toBe("XX-BBB");
    expect(out[0]!.device_b_interface).toBe("Eth0/1");
    expect(out[0]!.weight).toBe(7);
  });

  it("collapses A->B and B->A onto one canonical record, weight from later observed_at", () => {
    const earlier = row({
      device_a_name: "XX-AAA",
      device_a_interface: "Eth0/0",
      device_b_name: "XX-BBB",
      device_b_interface: "Eth0/1",
      weight: 10,
      observed_at: new Date("2026-01-01T00:00:00Z"),
    });
    const later = row({
      device_a_name: "XX-BBB",
      device_a_interface: "Eth0/1",
      device_b_name: "XX-AAA",
      device_b_interface: "Eth0/0",
      weight: 99,
      observed_at: new Date("2026-02-01T00:00:00Z"),
    });
    const out = canonicalizeIsisRows([earlier, later]);
    expect(out).toHaveLength(1);
    expect(out[0]!.device_a_name).toBe("XX-AAA");
    expect(out[0]!.device_b_name).toBe("XX-BBB");
    expect(out[0]!.weight).toBe(99);
    expect(out[0]!.observed_at.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("preserves multiple distinct pairs", () => {
    const a = row({
      device_a_name: "XX-AAA",
      device_b_name: "XX-BBB",
      weight: 10,
    });
    const b = row({
      device_a_name: "XX-CCC",
      device_b_name: "XX-DDD",
      weight: 20,
    });
    const c = row({
      device_a_name: "XX-EEE",
      device_b_name: "XX-FFF",
      weight: 30,
    });
    const out = canonicalizeIsisRows([a, b, c]);
    expect(out).toHaveLength(3);
    const weights = out.map((r) => r.weight).sort((x, y) => x - y);
    expect(weights).toEqual([10, 20, 30]);
  });

  it("same-pair, same-orientation, different timestamps → keep the later one", () => {
    const earlier = row({
      weight: 5,
      observed_at: new Date("2026-01-01T00:00:00Z"),
    });
    const later = row({
      weight: 50,
      observed_at: new Date("2026-03-01T00:00:00Z"),
    });
    const out = canonicalizeIsisRows([earlier, later]);
    expect(out).toHaveLength(1);
    expect(out[0]!.weight).toBe(50);
    expect(out[0]!.observed_at.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("empty input returns []", () => {
    expect(canonicalizeIsisRows([])).toEqual([]);
  });
});
