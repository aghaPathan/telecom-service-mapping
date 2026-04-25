import type { RawDwdmRow } from "../../src/source/dwdm.js";

/**
 * Synthetic 50-row DWDM fixture. Zero real data — all hostnames follow the
 * `XX-YYY-ROLE-NN` redaction convention per CLAUDE.md data-sensitivity rules.
 *
 * Coverage:
 *   - 20 symmetric pairs as 10 unique edges, 20 rows (both directions)
 *   - 15 one-direction edges, 15 rows (15 unique edges)
 *   - 2 anomaly groups of 3 rows each, 6 rows (2 unique edges, 4 anomalies)
 *   - 3 self-loops (3 rows, all dropped)
 *   - 3 null device_b_name rows (3 rows, all dropped)
 *   - 3 null device_a_name rows (3 rows, all dropped — `dedupDwdmRows`
 *     treats either-null as null_b per dedup.ts:218-223)
 *   Total: 20 + 15 + 6 + 3 + 3 + 3 = 50 rows
 *
 * Expected dedup output (see apps/ingestor/src/dedup.ts:dedupDwdmRows):
 *   edges:  10 + 15 + 2 = 27
 *   dropped: { null_b: 6, self_loop: 3, anomaly: 4 }
 *
 * Span name distribution:
 *   - >=5 rows ending in ' -  LD' (TWO spaces before LD)
 *   - >=5 rows ending in ' - NSR'
 *   - >=5 rows with span_name = null
 * snfn_cids distribution:
 *   - >=5 rows with multiple space-separated CIDs
 *   - >=5 rows with empty/null snfn_cids
 * Rings: RING-A, RING-B, RING-C represented.
 */

const T = (s: string): string => s;

// ---------------------------------------------------------------------------
// 20 rows: 10 symmetric pairs (both-direction). Each pair contributes 1 edge.
// Span names: pairs 1-3 end in ' -  LD' (2 spaces), pairs 4-6 end in ' - NSR',
// pairs 7-10 have null span_name. snfn_cids: pairs 1-3 multi-CID, pair 4 single,
// pairs 5-7 multi-CID, pairs 8-10 empty/null.
// ---------------------------------------------------------------------------
const symmetricPair = (
  i: number,
  ring: string,
  span: string | null,
  snfn: string | null,
  mobily: string | null,
): RawDwdmRow[] => {
  const a = `XX-AAA-DWDM-${String(i).padStart(2, "0")}`;
  const b = `XX-BBB-DWDM-${String(i).padStart(2, "0")}`;
  const aIf = `OTU2-${i}/0`;
  const bIf = `OTU2-${i}/1`;
  return [
    {
      device_a_name: a,
      device_a_interface: aIf,
      device_a_ip: `10.10.${i}.1`,
      device_b_name: b,
      device_b_interface: bIf,
      device_b_ip: `10.10.${i}.2`,
      ring,
      snfn_cids: snfn,
      mobily_cids: mobily,
      span_name: span,
    },
    {
      device_a_name: b,
      device_a_interface: bIf,
      device_a_ip: `10.10.${i}.2`,
      device_b_name: a,
      device_b_interface: aIf,
      device_b_ip: `10.10.${i}.1`,
      ring,
      snfn_cids: snfn,
      mobily_cids: mobily,
      span_name: span,
    },
  ];
};

// 15 one-direction edges. Mix of span/snfn variants to satisfy distribution.
const oneDirection = (
  i: number,
  ring: string,
  span: string | null,
  snfn: string | null,
): RawDwdmRow => ({
  device_a_name: `XX-CCC-DWDM-${String(i).padStart(2, "0")}`,
  device_a_interface: `OTU2-${i}/2`,
  device_a_ip: `10.20.${i}.1`,
  device_b_name: `XX-DDD-DWDM-${String(i).padStart(2, "0")}`,
  device_b_interface: `OTU2-${i}/3`,
  device_b_ip: `10.20.${i}.2`,
  ring,
  snfn_cids: snfn,
  mobily_cids: null,
  span_name: span,
});

// Anomaly group: 3 rows for the same canonical pair. First seen wins; rows 2-3
// each increment dropped.anomaly. 2 groups → 6 rows, 2 edges, 4 anomalies.
const anomalyGroup = (i: number): RawDwdmRow[] => {
  const a = `XX-EEE-DWDM-${String(i).padStart(2, "0")}`;
  const b = `XX-FFF-DWDM-${String(i).padStart(2, "0")}`;
  const aIf = `OTU2-9/${i}`;
  const bIf = `OTU2-9/${i + 10}`;
  const base: RawDwdmRow = {
    device_a_name: a,
    device_a_interface: aIf,
    device_a_ip: `10.30.${i}.1`,
    device_b_name: b,
    device_b_interface: bIf,
    device_b_ip: `10.30.${i}.2`,
    ring: "RING-C",
    snfn_cids: "CID-A50 CID-A51",
    mobily_cids: null,
    span_name: T(" - NSR"),
  };
  return [base, { ...base }, { ...base }];
};

// Self-loop: dropped.
const selfLoop = (i: number): RawDwdmRow => ({
  device_a_name: `XX-LLL-DWDM-${String(i).padStart(2, "0")}`,
  device_a_interface: "OTU2-LO/0",
  device_a_ip: null,
  device_b_name: `XX-LLL-DWDM-${String(i).padStart(2, "0")}`,
  device_b_interface: "OTU2-LO/0",
  device_b_ip: null,
  ring: null,
  snfn_cids: null,
  mobily_cids: null,
  span_name: null,
});

// Null device_b_name: dropped (counted as null_b).
const nullB = (i: number): RawDwdmRow => ({
  device_a_name: `XX-GGG-DWDM-${String(i).padStart(2, "0")}`,
  device_a_interface: `OTU2-${i}/9`,
  device_a_ip: null,
  device_b_name: null,
  device_b_interface: null,
  device_b_ip: null,
  ring: "RING-A",
  snfn_cids: null,
  mobily_cids: null,
  span_name: null,
});

// Null device_a_name: dropped (also counted as null_b per dedupDwdmRows).
const nullA = (i: number): RawDwdmRow => ({
  device_a_name: null,
  device_a_interface: null,
  device_a_ip: null,
  device_b_name: `XX-HHH-DWDM-${String(i).padStart(2, "0")}`,
  device_b_interface: `OTU2-${i}/8`,
  device_b_ip: null,
  ring: "RING-B",
  snfn_cids: null,
  mobily_cids: null,
  span_name: null,
});

// ---------------------------------------------------------------------------
// Compose 50 rows.
// Span / snfn distribution lives in the symmetric + one-direction sections.
// ---------------------------------------------------------------------------

// Symmetric pairs 1-10 → 20 rows.
//   1-3: span " -  LD" (LD), multi-CID snfn_cids   (RING-A) → 6 rows + 3 LD
//   4-5: span " -  LD" (LD), single-CID snfn_cids  (RING-A) → 4 rows + 2 LD  (LD total = 5)
//   6-8: span " - NSR",      multi-CID snfn_cids   (RING-B) → 6 rows + 3 NSR (multi total >=5: 3+2+3+1=9)
//   9-10: span null,         null snfn_cids        (RING-B) → 4 rows + 2 null span / 4 null/empty snfn
const symRows: RawDwdmRow[] = [
  ...symmetricPair(1, "RING-A", T(" -  LD"), "CID-A01 CID-A02", "MCID-A01"),
  ...symmetricPair(2, "RING-A", T(" -  LD"), "CID-A03 CID-A04 CID-A05", "MCID-A02"),
  ...symmetricPair(3, "RING-A", T(" -  LD"), "CID-A06 CID-A07", null),
  ...symmetricPair(4, "RING-A", T(" -  LD"), "CID-A08", null),
  ...symmetricPair(5, "RING-A", T(" -  LD"), "CID-A09", null),
  ...symmetricPair(6, "RING-B", T(" - NSR"), "CID-A10 CID-A11", null),
  ...symmetricPair(7, "RING-B", T(" - NSR"), "CID-A12 CID-A13", null),
  ...symmetricPair(8, "RING-B", T(" - NSR"), "CID-A14 CID-A15 CID-A16", null),
  ...symmetricPair(9, "RING-B", null, null, null),
  ...symmetricPair(10, "RING-B", null, null, null),
];

// One-direction rows 1-15 → 15 rows.
//   1-3: span " - NSR"   (NSR running total 3+3=6)             multi-CID snfn
//   4-6: span " -  LD"   (LD already at 5; extra LDs OK)       single CID
//   7-9: span null       (null span: 4+3=7, hits >=5)          empty snfn ""
//  10-12: span " - NSR"  multi-CID
//  13-15: span null      null snfn
const oneDirRows: RawDwdmRow[] = [
  oneDirection(1, "RING-A", T(" - NSR"), "CID-A20 CID-A21"),
  oneDirection(2, "RING-A", T(" - NSR"), "CID-A22 CID-A23"),
  oneDirection(3, "RING-A", T(" - NSR"), "CID-A24 CID-A25"),
  oneDirection(4, "RING-B", T(" -  LD"), "CID-A26"),
  oneDirection(5, "RING-B", T(" -  LD"), "CID-A27"),
  oneDirection(6, "RING-B", T(" -  LD"), "CID-A28"),
  oneDirection(7, "RING-C", null, ""),
  oneDirection(8, "RING-C", null, ""),
  oneDirection(9, "RING-C", null, ""),
  oneDirection(10, "RING-C", T(" - NSR"), "CID-A29 CID-A30"),
  oneDirection(11, "RING-C", T(" - NSR"), "CID-A31 CID-A32"),
  oneDirection(12, "RING-C", T(" - NSR"), "CID-A33 CID-A34"),
  oneDirection(13, "RING-A", null, null),
  oneDirection(14, "RING-A", null, null),
  oneDirection(15, "RING-A", null, null),
];

// Anomaly groups: 2 groups × 3 rows = 6 rows.
const anomalyRows: RawDwdmRow[] = [
  ...anomalyGroup(1),
  ...anomalyGroup(2),
];

// Drops: 3 self-loops + 3 null_b + 3 null_a = 9 rows.
const dropRows: RawDwdmRow[] = [
  selfLoop(1),
  selfLoop(2),
  selfLoop(3),
  nullB(1),
  nullB(2),
  nullB(3),
  nullA(1),
  nullA(2),
  nullA(3),
];

export const dwdm50: RawDwdmRow[] = [
  ...symRows, // 20
  ...oneDirRows, // 15
  ...anomalyRows, // 6
  ...dropRows, // 9
];

if (dwdm50.length !== 50) {
  throw new Error(`dwdm50 expected 50 rows, got ${dwdm50.length}`);
}
