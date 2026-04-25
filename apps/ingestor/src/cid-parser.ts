/**
 * V1 source: data_populate.py:36-42. V1 had `elif` between LD and NSR which
 * meant NSR was unreachable for inputs containing both substrings — V2
 * contract rule #27 fixes by handling each branch independently.
 *
 * Note ` -  LD` has TWO spaces between `-` and `LD`; ` - NSR` has one space on each side.
 */
export function stripSpanSuffix(s: string | null): string | null {
  if (s === null || s === "") return null;
  let out = s;
  if (out.includes(" -  LD")) out = out.split(" -  LD")[0];
  if (out.includes(" - NSR")) out = out.split(" - NSR")[0];
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
