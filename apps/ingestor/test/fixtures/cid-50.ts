import type { RawCidRow } from "../../src/source/cid.js";

/**
 * Synthetic 50-row CID fixture for `public.app_cid`. Zero real data.
 * All `cid` values cross-reference at least one CID name appearing in
 * `dwdm-50.ts`'s `snfn_cids` field.
 *
 * protection_cid distribution (V1 contract rules #20, #21 — see
 * apps/ingestor/src/cid-parser.ts):
 *   - 20 rows: single CID name           (e.g. "PCID-001")
 *   - 15 rows: 'nan' sentinel            (V1's null-as-string sentinel)
 *   - 10 rows: '' empty string
 *   -  5 rows: space-separated multi-CID (e.g. "PCID-X PCID-Y")
 *   Total: 50 rows
 *
 * `cid` is non-null on every row (the source reader filters null cids
 * upstream — `WHERE cid IS NOT NULL` in source/cid.ts).
 */

const row = (
  cid: string,
  protection_cid: string | null,
  source: string | null = "XX-AAA-DWDM-01",
  dest: string | null = "XX-BBB-DWDM-01",
): RawCidRow => ({
  cid,
  capacity: "10G",
  source,
  dest,
  bandwidth: "10000",
  protection_type: "1+1",
  protection_cid,
  mobily_cid: `MCID-${cid}`,
  region: "Region-X",
});

// 20 rows: single-CID protection_cid. Cids cross-reference dwdm-50 snfn_cids.
const singleProtection: RawCidRow[] = [
  row("CID-A01", "PCID-001"),
  row("CID-A02", "PCID-002"),
  row("CID-A03", "PCID-003"),
  row("CID-A04", "PCID-004"),
  row("CID-A05", "PCID-005"),
  row("CID-A06", "PCID-006"),
  row("CID-A07", "PCID-007"),
  row("CID-A08", "PCID-008"),
  row("CID-A09", "PCID-009"),
  row("CID-A10", "PCID-010"),
  row("CID-A11", "PCID-011"),
  row("CID-A12", "PCID-012"),
  row("CID-A13", "PCID-013"),
  row("CID-A14", "PCID-014"),
  row("CID-A15", "PCID-015"),
  row("CID-A16", "PCID-016"),
  row("CID-A20", "PCID-020"),
  row("CID-A21", "PCID-021"),
  row("CID-A22", "PCID-022"),
  row("CID-A23", "PCID-023"),
];

// 15 rows: 'nan' sentinel.
const nanProtection: RawCidRow[] = [
  row("CID-A24", "nan"),
  row("CID-A25", "nan"),
  row("CID-A26", "nan"),
  row("CID-A27", "nan"),
  row("CID-A28", "nan"),
  row("CID-A29", "nan"),
  row("CID-A30", "nan"),
  row("CID-A31", "nan"),
  row("CID-A32", "nan"),
  row("CID-A33", "nan"),
  row("CID-A34", "nan"),
  row("CID-A50", "nan"),
  row("CID-A51", "nan"),
  row("CID-A01-DUP-N1", "nan"),
  row("CID-A02-DUP-N2", "nan"),
];

// 10 rows: empty-string protection_cid.
const emptyProtection: RawCidRow[] = [
  row("CID-A03-DUP-E1", ""),
  row("CID-A04-DUP-E2", ""),
  row("CID-A05-DUP-E3", ""),
  row("CID-A06-DUP-E4", ""),
  row("CID-A07-DUP-E5", ""),
  row("CID-A08-DUP-E6", ""),
  row("CID-A09-DUP-E7", ""),
  row("CID-A10-DUP-E8", ""),
  row("CID-A11-DUP-E9", ""),
  row("CID-A12-DUP-E10", ""),
];

// 5 rows: space-separated protection_cid list.
const multiProtection: RawCidRow[] = [
  row("CID-A13-DUP-M1", "PCID-X01 PCID-Y01"),
  row("CID-A14-DUP-M2", "PCID-X02 PCID-Y02"),
  row("CID-A15-DUP-M3", "PCID-X03 PCID-Y03 PCID-Z03"),
  row("CID-A16-DUP-M4", "PCID-X04 PCID-Y04"),
  row("CID-A20-DUP-M5", "PCID-X05 PCID-Y05"),
];

export const cid50: RawCidRow[] = [
  ...singleProtection, // 20
  ...nanProtection, // 15
  ...emptyProtection, // 10
  ...multiProtection, // 5
];

if (cid50.length !== 50) {
  throw new Error(`cid50 expected 50 rows, got ${cid50.length}`);
}
