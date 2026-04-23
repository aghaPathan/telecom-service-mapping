/**
 * Synthetic 50-row LLDP fixture. Zero real data — all hostnames follow the
 * `XX-YYY-ROLE-NN` redaction convention per CLAUDE.md data-sensitivity rules.
 *
 * Coverage (maps 1:1 to dedup.test.ts cases):
 *   - 10 symmetric pairs (both-direction rows → 20 rows, 10 links)
 *   - 10 one-direction pairs (10 rows, 10 links)
 *   - 3 anomaly groups (3 rows each with varying updated_at → 9 rows, 3 links + 6 warnings)
 *   - 2 self-loops (dropped)
 *   - 2 null-device_b_name rows (dropped)
 *   - 2 unicode device names (1 row each, 2 links)
 *   - 2 mixed-case hostname pairs (2 rows, 1 link, first-seen casing preserved)
 *
 * Total rows: 20 + 10 + 9 + 2 + 2 + 2 + 2 = 47. Plus 3 filler one-direction
 * rows to reach exactly 50.
 *
 * Expected dedup output:
 *   devices: 10*2 + 10*2 + 3*2 + 2*2 + 2 + 1 + 3*2 = 51 unique device names
 *   links  : 10 + 10 + 3 + 2 + 1 + 3 = 29
 *   dropped: { null_b: 2, self_loop: 2, anomaly: 6 }
 *   warnings: 6 (2 per anomaly group)
 */

export type FixtureRow = {
  device_a_name: string | null;
  device_a_interface: string | null;
  device_a_trunk_name: string | null;
  device_a_ip: string | null;
  device_a_mac: string | null;
  device_b_name: string | null;
  device_b_interface: string | null;
  device_b_ip: string | null;
  device_b_mac: string | null;
  vendor_a: string | null;
  vendor_b: string | null;
  domain_a: string | null;
  domain_b: string | null;
  type_a: string | null;
  type_b: string | null;
  updated_at: Date;
};

const T = (iso: string): Date => new Date(iso);

const symmetricPair = (i: number): FixtureRow[] => {
  const a = `XX-AAA-CORE-${String(i).padStart(2, "0")}`;
  const b = `XX-BBB-UPE-${String(i).padStart(2, "0")}`;
  const aIf = `xe-0/0/${i}`;
  const bIf = `Gi1/${i}`;
  const base = T(`2026-04-20T10:00:${String(i).padStart(2, "0")}Z`);
  return [
    {
      device_a_name: a,
      device_a_interface: aIf,
      device_a_trunk_name: `ae${i}`,
      device_a_ip: `10.0.0.${i}`,
      device_a_mac: `aa:aa:aa:00:00:${String(i).padStart(2, "0")}`,
      device_b_name: b,
      device_b_interface: bIf,
      device_b_ip: `10.0.1.${i}`,
      device_b_mac: `bb:bb:bb:00:00:${String(i).padStart(2, "0")}`,
      vendor_a: "Juniper",
      vendor_b: "Cisco",
      domain_a: "core",
      domain_b: "agg",
      type_a: "CORE",
      type_b: "UPE",
      updated_at: base,
    },
    {
      device_a_name: b,
      device_a_interface: bIf,
      device_a_trunk_name: null,
      device_a_ip: `10.0.1.${i}`,
      device_a_mac: `bb:bb:bb:00:00:${String(i).padStart(2, "0")}`,
      device_b_name: a,
      device_b_interface: aIf,
      device_b_ip: `10.0.0.${i}`,
      device_b_mac: `aa:aa:aa:00:00:${String(i).padStart(2, "0")}`,
      vendor_a: "Cisco",
      vendor_b: "Juniper",
      domain_a: "agg",
      domain_b: "core",
      type_a: "UPE",
      type_b: "CORE",
      updated_at: base,
    },
  ];
};

const oneDirectionPair = (i: number): FixtureRow => ({
  device_a_name: `XX-CCC-CSG-${String(i).padStart(2, "0")}`,
  device_a_interface: `Gi0/${i}`,
  device_a_trunk_name: null,
  device_a_ip: `10.1.0.${i}`,
  device_a_mac: `cc:cc:cc:00:00:${String(i).padStart(2, "0")}`,
  device_b_name: `XX-DDD-RAN-${String(i).padStart(2, "0")}`,
  device_b_interface: `eth-${i}`,
  device_b_ip: `10.1.1.${i}`,
  device_b_mac: `dd:dd:dd:00:00:${String(i).padStart(2, "0")}`,
  vendor_a: "Cisco",
  vendor_b: "Huawei",
  domain_a: "access",
  domain_b: "access",
  type_a: "CSG",
  type_b: null,
  updated_at: T(`2026-04-20T11:00:${String(i).padStart(2, "0")}Z`),
});

// Anomaly group: 3 rows for the same canonical pair with different updated_at.
// Latest wins, other two emit warnings.
const anomalyGroup = (i: number): FixtureRow[] => {
  const a = `XX-EEE-AGG-${String(i).padStart(2, "0")}`;
  const b = `XX-FFF-AGG-${String(i).padStart(2, "0")}`;
  const aIf = `et-0/0/${i}`;
  const bIf = `et-0/0/${i}`;
  return [
    {
      device_a_name: a,
      device_a_interface: aIf,
      device_a_trunk_name: null,
      device_a_ip: null,
      device_a_mac: null,
      device_b_name: b,
      device_b_interface: bIf,
      device_b_ip: null,
      device_b_mac: null,
      vendor_a: "Juniper",
      vendor_b: "Juniper",
      domain_a: "agg",
      domain_b: "agg",
      type_a: null,
      type_b: null,
      updated_at: T(`2026-04-18T08:00:${String(i).padStart(2, "0")}Z`),
    },
    {
      device_a_name: a,
      device_a_interface: aIf,
      device_a_trunk_name: null,
      device_a_ip: null,
      device_a_mac: null,
      device_b_name: b,
      device_b_interface: bIf,
      device_b_ip: null,
      device_b_mac: null,
      vendor_a: "Juniper",
      vendor_b: "Juniper",
      domain_a: "agg",
      domain_b: "agg",
      type_a: null,
      type_b: null,
      updated_at: T(`2026-04-19T08:00:${String(i).padStart(2, "0")}Z`),
    },
    {
      device_a_name: a,
      device_a_interface: aIf,
      device_a_trunk_name: "ae99",
      device_a_ip: "10.2.0.1",
      device_a_mac: "ee:ee:ee:00:00:01",
      device_b_name: b,
      device_b_interface: bIf,
      device_b_ip: "10.2.0.2",
      device_b_mac: "ff:ff:ff:00:00:01",
      vendor_a: "Juniper",
      vendor_b: "Juniper",
      domain_a: "agg",
      domain_b: "agg",
      type_a: null,
      type_b: null,
      updated_at: T(`2026-04-20T08:00:${String(i).padStart(2, "0")}Z`),
    },
  ];
};

const selfLoop = (name: string): FixtureRow => ({
  device_a_name: name,
  device_a_interface: "lo0",
  device_a_trunk_name: null,
  device_a_ip: null,
  device_a_mac: null,
  device_b_name: name,
  device_b_interface: "lo0",
  device_b_ip: null,
  device_b_mac: null,
  vendor_a: null,
  vendor_b: null,
  domain_a: null,
  domain_b: null,
  type_a: null,
  type_b: null,
  updated_at: T("2026-04-20T12:00:00Z"),
});

const nullB = (i: number): FixtureRow => ({
  device_a_name: `XX-GGG-SW-${String(i).padStart(2, "0")}`,
  device_a_interface: `Gi0/${i}`,
  device_a_trunk_name: null,
  device_a_ip: null,
  device_a_mac: null,
  device_b_name: null,
  device_b_interface: null,
  device_b_ip: null,
  device_b_mac: null,
  vendor_a: null,
  vendor_b: null,
  domain_a: null,
  domain_b: null,
  type_a: null,
  type_b: null,
  updated_at: T(`2026-04-20T13:00:${String(i).padStart(2, "0")}Z`),
});

const unicodeRow = (a: string, b: string, suffix: string): FixtureRow => ({
  device_a_name: a,
  device_a_interface: `et-${suffix}`,
  device_a_trunk_name: null,
  device_a_ip: null,
  device_a_mac: null,
  device_b_name: b,
  device_b_interface: `et-${suffix}-peer`,
  device_b_ip: null,
  device_b_mac: null,
  vendor_a: "Nokia",
  vendor_b: "Nokia",
  domain_a: "core",
  domain_b: "core",
  type_a: "CORE",
  type_b: "CORE",
  updated_at: T("2026-04-20T14:00:00Z"),
});

// Mixed-case pair: same logical link described twice with different casings.
// First-seen casing for each device name should win.
const mixedCasePair: FixtureRow[] = [
  {
    device_a_name: "XX-HHH-CORE-01",
    device_a_interface: "xe-1/0/0",
    device_a_trunk_name: null,
    device_a_ip: null,
    device_a_mac: null,
    device_b_name: "XX-III-CORE-02",
    device_b_interface: "xe-1/0/1",
    device_b_ip: null,
    device_b_mac: null,
    vendor_a: "Juniper",
    vendor_b: "Juniper",
    domain_a: "core",
    domain_b: "core",
    type_a: "CORE",
    type_b: "CORE",
    updated_at: T("2026-04-20T15:00:00Z"),
  },
  {
    device_a_name: "xx-hhh-core-01",
    device_a_interface: "xe-1/0/0",
    device_a_trunk_name: null,
    device_a_ip: null,
    device_a_mac: null,
    device_b_name: "xx-iii-core-02",
    device_b_interface: "xe-1/0/1",
    device_b_ip: null,
    device_b_mac: null,
    vendor_a: "Juniper",
    vendor_b: "Juniper",
    domain_a: "core",
    domain_b: "core",
    type_a: "CORE",
    type_b: "CORE",
    updated_at: T("2026-04-20T15:00:05Z"),
  },
];

// Filler one-direction pairs with unique indices to hit exactly 50 rows.
const fillerOneDirection = (i: number): FixtureRow => ({
  device_a_name: `XX-JJJ-TRANS-${String(i).padStart(2, "0")}`,
  device_a_interface: `Gi2/${i}`,
  device_a_trunk_name: null,
  device_a_ip: null,
  device_a_mac: null,
  device_b_name: `XX-KKK-TRANS-${String(i).padStart(2, "0")}`,
  device_b_interface: `Gi2/${i}`,
  device_b_ip: null,
  device_b_mac: null,
  vendor_a: "Cisco",
  vendor_b: "Cisco",
  domain_a: "transport",
  domain_b: "transport",
  type_a: null,
  type_b: null,
  updated_at: T(`2026-04-20T16:00:${String(i).padStart(2, "0")}Z`),
});

export const FIXTURE: FixtureRow[] = [
  // 10 symmetric pairs → 20 rows
  ...Array.from({ length: 10 }, (_, i) => symmetricPair(i + 1)).flat(),
  // 10 one-direction → 10 rows
  ...Array.from({ length: 10 }, (_, i) => oneDirectionPair(i + 1)),
  // 3 anomaly groups → 9 rows
  ...Array.from({ length: 3 }, (_, i) => anomalyGroup(i + 1)).flat(),
  // 2 self-loops
  selfLoop("XX-LLL-LOOP-01"),
  selfLoop("XX-LLL-LOOP-02"),
  // 2 null-b
  nullB(1),
  nullB(2),
  // 2 unicode pairs
  unicodeRow("Δ-CORE-01", "Δ-CORE-02", "delta"),
  unicodeRow("日本-UPE-01", "日本-UPE-02", "jp"),
  // Mixed-case pair → 2 rows (1 logical link)
  ...mixedCasePair,
  // 3 filler one-direction pairs
  fillerOneDirection(1),
  fillerOneDirection(2),
  fillerOneDirection(3),
];

// Assert 50 rows at import time (guards against accidental fixture drift).
if (FIXTURE.length !== 50) {
  throw new Error(`Fixture expected 50 rows, got ${FIXTURE.length}`);
}
