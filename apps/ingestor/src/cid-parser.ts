/**
 * V1 source: data_populate.py:36-42. V1 had `elif` between LD and NSR which
 * meant NSR was unreachable for inputs containing both substrings — V2
 * contract rule #27 fixes by handling each branch independently.
 *
 * Note ` -  LD` has TWO spaces between `-` and `LD`; ` - NSR` has one space on each side.
 */
export function stripSpanSuffix(s: string | null): string | null {
  if (s === null || s.trim() === "") return null;
  let out = s;
  const ldIdx = out.indexOf(" -  LD");
  if (ldIdx >= 0) out = out.slice(0, ldIdx);
  const nsrIdx = out.indexOf(" - NSR");
  if (nsrIdx >= 0) out = out.slice(0, nsrIdx);
  return out.trim();
}

/**
 * V1 callers split SNFN/Mobily CID strings on whitespace; some upstream sources
 * use commas. Treat both as separators. The 'nan' sentinel is V1's stringified
 * Python NaN — collapse to empty list (rule #20 contract for CID lists).
 */
export function parseCidList(s: string | null): string[] {
  if (s === null) return [];
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return [];
  return trimmed
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * V1 source: Topo.py:914-920. V1 uses split(" ") and reads [0] as the
 * active protection CID. We preserve full ordering so callers can pick [0]
 * explicitly. Comma is NOT a separator here — V1's app_cid.protection_cid
 * column is space-separated only. Contract rules #20 ('nan' / empty → []),
 * #21 (space-split, first wins).
 */
export function parseProtectionCids(s: string | null): string[] {
  if (s === null) return [];
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan") return [];
  return trimmed.split(/\s+/).filter((t) => t.length > 0);
}
