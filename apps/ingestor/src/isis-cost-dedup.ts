import type { IsisCostRow } from "./source/isis-cost.js";

/**
 * Fold A→B and B→A onto a single canonical record per unordered
 * `{(device, interface), (device, interface)}` pair.
 *
 * Canonical orientation: the lexicographically smaller `(name, interface)`
 * tuple is the "A" side; the larger is "B". This guarantees deterministic
 * output regardless of input ordering.
 *
 * When two input rows hash to the same canonical key, the row with the
 * later `observed_at` wins (its `weight` and `observed_at` are kept).
 * Tie-break on equal `observed_at` is undefined; we never throw.
 *
 * Pure function: no I/O, no globals.
 */
export function canonicalizeIsisRows(rows: IsisCostRow[]): IsisCostRow[] {
  const byKey = new Map<string, IsisCostRow>();

  for (const r of rows) {
    const aTuple: [string, string] = [r.device_a_name, r.device_a_interface];
    const bTuple: [string, string] = [r.device_b_name, r.device_b_interface];

    // Lexicographic compare on (name, interface) — name first, interface as tiebreak.
    const aFirst = compareTuple(aTuple, bTuple) <= 0;
    const lo = aFirst ? aTuple : bTuple;
    const hi = aFirst ? bTuple : aTuple;

    const canonical: IsisCostRow = {
      device_a_name: lo[0],
      device_a_interface: lo[1],
      device_b_name: hi[0],
      device_b_interface: hi[1],
      weight: r.weight,
      observed_at: r.observed_at,
    };

    const key = `${lo[0]}|${lo[1]}|${hi[0]}|${hi[1]}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, canonical);
      continue;
    }
    if (canonical.observed_at.getTime() > existing.observed_at.getTime()) {
      byKey.set(key, canonical);
    }
  }

  return Array.from(byKey.values());
}

function compareTuple(a: [string, string], b: [string, string]): number {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}
