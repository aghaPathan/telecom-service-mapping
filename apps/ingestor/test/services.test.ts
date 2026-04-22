import { describe, expect, it } from "vitest";
import { buildServicesGraph } from "../src/services.ts";
import type {
  RawDeviceCidRow,
  RawServiceRow,
} from "../src/source/services.ts";

const svc = (cid: string, overrides: Partial<RawServiceRow> = {}): RawServiceRow => ({
  cid,
  source: null,
  dest: null,
  bandwidth: null,
  protection_type: null,
  protection_cid: null,
  mobily_cid: null,
  region: null,
  ...overrides,
});

const dc = (
  cid: string,
  a: string | null,
  b: string | null,
): RawDeviceCidRow => ({ cid, device_a_name: a, device_b_name: b });

describe("buildServicesGraph", () => {
  it("maps source/dest columns to TERMINATES_AT with correct roles", () => {
    const r = buildServicesGraph(
      [svc("CID-1", { source: "DEV-A", dest: "DEV-B" })],
      [],
    );
    expect(r.services).toHaveLength(1);
    expect(r.terminates).toEqual([
      { cid: "CID-1", device: "DEV-A", role: "source" },
      { cid: "CID-1", device: "DEV-B", role: "dest" },
    ]);
  });

  it("falls back to app_devicecid when source/dest are null", () => {
    const r = buildServicesGraph(
      [svc("CID-1")],
      [dc("CID-1", "DEV-A", "DEV-B")],
    );
    expect(r.terminates).toEqual([
      { cid: "CID-1", device: "DEV-A", role: "source" },
      { cid: "CID-1", device: "DEV-B", role: "dest" },
    ]);
  });

  it("deduplicates terminate edges across source tables", () => {
    const r = buildServicesGraph(
      [svc("CID-1", { source: "DEV-A", dest: "DEV-B" })],
      [dc("CID-1", "DEV-A", "DEV-B")],
    );
    expect(r.terminates).toHaveLength(2);
  });

  it("drops terminate edges with missing device and counts them", () => {
    const r = buildServicesGraph(
      [svc("CID-1", { source: null, dest: null })],
      [dc("CID-1", null, null)],
    );
    expect(r.terminates).toHaveLength(0);
    expect(r.dropped.terminate_missing_device).toBe(4);
  });

  it("creates a PROTECTED_BY edge when protection_cid points at a known service", () => {
    const r = buildServicesGraph(
      [
        svc("PRIMARY", { protection_cid: "BACKUP" }),
        svc("BACKUP"),
      ],
      [],
    );
    expect(r.protections).toEqual([
      { primary_cid: "PRIMARY", backup_cid: "BACKUP" },
    ]);
  });

  it("drops PROTECTED_BY self-loops and unknown-cid references", () => {
    const r = buildServicesGraph(
      [
        svc("A", { protection_cid: "A" }),            // self-loop
        svc("B", { protection_cid: "MISSING" }),      // unknown cid
        svc("C", { protection_cid: "D" }),
        svc("D"),
      ],
      [],
    );
    expect(r.protections).toEqual([{ primary_cid: "C", backup_cid: "D" }]);
    expect(r.dropped.protection_self_loop).toBe(1);
    expect(r.dropped.protection_unknown_cid).toBe(1);
  });

  it("deduplicates services by cid, keeping first-seen", () => {
    const r = buildServicesGraph(
      [
        svc("CID-1", { bandwidth: "100M" }),
        svc("CID-1", { bandwidth: "200M" }),
      ],
      [],
    );
    expect(r.services).toHaveLength(1);
    expect(r.services[0]!.bandwidth).toBe("100M");
    expect(r.dropped.duplicate_cid).toBe(1);
  });

  it("ignores device-cid rows that reference an unknown service", () => {
    const r = buildServicesGraph(
      [svc("CID-1", { source: "DEV-A", dest: "DEV-B" })],
      [dc("CID-UNKNOWN", "DEV-X", "DEV-Y")],
    );
    expect(r.terminates).toHaveLength(2);
  });
});
