// Shared coercion helpers for Neo4j driver return values. The bolt driver
// returns Integer objects for graph-int values; `toNum` narrows them back
// to JS number safely. `toStrOrNull` mirrors the same pattern for optional
// string properties. Consolidated here once a second caller appeared — see
// CLAUDE.md "DRY with 2+ duplicates gate".

type Nr = { toNumber: () => number };

export function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}

export function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function toBoolOrNull(v: unknown): boolean | null {
  if (v == null) return null;
  return Boolean(v);
}
